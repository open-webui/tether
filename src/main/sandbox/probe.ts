import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PtyProcess, ServiceLaunch } from '../process/managedService'
import { SandboxError, type SandboxPolicy } from './policy'

// Verify real enforcement before exposing Open Terminal. This also catches host/OS regressions.
export async function probeSandbox(
  launch: ServiceLaunch,
  policy: SandboxPolicy,
  signal: AbortSignal,
  spawn: (launch: ServiceLaunch, policy: SandboxPolicy, signal: AbortSignal) => Promise<PtyProcess>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tether-probe-')))
  const deniedFile = join(root, 'outside')
  const allowedFile = join(policy.sessionPath, 'probe')
  const marker = 'TETHER_SANDBOX_' + randomUUID()
  const server = createServer((socket) => socket.destroy())
  let child: PtyProcess | undefined
  let exited = false
  let resolveExit!: () => void
  const processExit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)])
  try {
    await writeFile(deniedFile, 'outside sandbox', { mode: 0o600 })
    if (process.platform === 'win32') {
      // An implicit ALL APPLICATION PACKAGES grant must not bypass our explicit denial.
      await promisify(execFile)('icacls.exe', [root, '/grant', '*S-1-15-2-1:(OI)(CI)RX', '/T'], {
        windowsHide: true,
        signal: deadline
      })
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new SandboxError('Could not verify network isolation.')
    const script = `
import errno, os, pathlib, socket
outside = ${JSON.stringify(deniedFile)}
allowed = pathlib.Path(${JSON.stringify(allowedFile)})
allowed.write_text('ok')
assert allowed.read_text() == 'ok'
allowed.unlink()
for mode in ('r', 'w'):
    try:
        f = open(outside, mode)
    except OSError as e:
        assert e.errno in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.EROFS), str(e)
    else:
        f.close()
        raise RuntimeError('Outside filesystem access was allowed')
${
  !policy.networkAccess || policy.backend === 'processcontainer'
    ? `
try:
    connection = socket.create_connection(('127.0.0.1', ${address.port}), timeout=1)
except OSError:
    pass
else:
    connection.close()
    raise RuntimeError('Host network access was allowed')
`
    : ''
}
print(${JSON.stringify(marker)}, flush=True)
`
    child = await spawn({ ...launch, args: ['-I', '-c', script] }, policy, deadline)
    let output = ''
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(deadline.reason)
      }
      const data = child!.onData((chunk) => {
        output = (output + chunk).slice(-16384)
      })
      const exit = child!.onExit(({ exitCode }) => {
        exited = true
        resolveExit()
        data.dispose()
        exit.dispose()
        deadline.removeEventListener('abort', abort)
        if (exitCode === 0 && output.includes(marker)) resolve()
        else
          reject(
            new SandboxError(
              'Sandbox verification failed. File or network isolation could not be established.'
            )
          )
      })
      deadline.addEventListener('abort', abort, { once: true })
      if (deadline.aborted) abort()
    })
  } finally {
    if (child && !exited) {
      await child.kill(true)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          processExit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new SandboxError('Sandbox verification process did not exit.')),
              2000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    server.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowedFile, { force: true })
  }
}
