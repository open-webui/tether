import { t } from './i18n'
import { app, session } from 'electron'
import log from 'electron-log'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { x as extract } from 'tar'
import extractZip from 'extract-zip'

const execute = promisify(execFile)
const pythonChecksums: Record<string, string> = {
  'aarch64-apple-darwin': '58038f6643b0c51385aa8af1549d2f6d9598c7a48383b9c74fc65481b2b5e6d5',
  'aarch64-pc-windows-msvc': '23a9d18ad7d62e8470f6dfbf3e3ddc8c6a343ec8a07bad0197689f96f024a98f',
  'aarch64-unknown-linux-gnu': '872bb2d9959bbcba411af08fa57423d586b779c21c7de70890f99e1c59036efc',
  'x86_64-apple-darwin': '09d7bfb7e2684d746e2d44bd800becfd07c4c672de907340d279409a8bca2d8b',
  'x86_64-pc-windows-msvc': 'b9f9d17a11944c13a3a2798c8b48ec861b2f10710dc345094f567beed4271427',
  'x86_64-unknown-linux-gnu': 'eddc8bf40c7fca5032acd5de4b89e748e17b16cf61918320a0506c7e450a8df3'
}

const nodeVersion = '24.22.2'
const nodeChecksums: Record<string, string> = {
  'darwin-arm64': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  'darwin-x64': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  'linux-arm64': '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  'linux-x64': '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  'win-arm64': 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468',
  'win-x64': 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
}

function describeDownloadError(error: unknown, seen = new Set<unknown>()): string {
  if (!(error instanceof Error)) return String(error)
  if (seen.has(error)) return ''
  seen.add(error)

  const code = 'code' in error ? String(error.code) : ''
  const details = [code ? `${error.message} (${code})` : error.message]
  if (error.cause !== undefined) details.push(describeDownloadError(error.cause, seen))
  if (error instanceof AggregateError)
    details.push(...error.errors.map((cause) => describeDownloadError(cause, seen)))
  return details.filter(Boolean).join(': ')
}

export interface RuntimeProcess {
  process: ChildProcess
  readonly exited: boolean
  stop(): Promise<void>
}

export class Runtime {
  private root = app.getPath('userData')
  readonly directory: string
  readonly executable: string
  private abort = new AbortController()
  readonly signal = this.abort.signal
  private installation?: Promise<void>
  private children = new Set<RuntimeProcess>()

  constructor(
    readonly kind: 'python' | 'node',
    private output: (data: string) => void = () => {}
  ) {
    this.directory = join(this.root, kind)
    this.executable = join(
      this.directory,
      kind === 'python'
        ? process.platform === 'win32'
          ? 'python.exe'
          : 'bin/python3'
        : process.platform === 'win32'
          ? 'node.exe'
          : 'bin/node'
    )
  }

  private get npm(): string {
    return join(
      this.directory,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'npm/bin/npm-cli.js'
    )
  }

  environment(): NodeJS.ProcessEnv {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(PYTHON|PIP_|UV_|NPM_CONFIG_|LD_PRELOAD$|LD_AUDIT$|DYLD_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_)/i.test(
            key
          )
      )
    )
    return {
      ...env,
      PATH: [
        dirname(this.executable),
        ...(this.kind === 'node' ? [join(this.directory, 'packages/node_modules/.bin')] : []),
        env.PATH ?? env.Path ?? ''
      ].join(delimiter),
      ...(this.kind === 'python'
        ? {
            PYTHONUNBUFFERED: '1',
            PYTHONNOUSERSITE: '1',
            PYTHONIOENCODING: 'utf-8',
            PIP_DISABLE_PIP_VERSION_CHECK: '1'
          }
        : {
            NPM_CONFIG_USERCONFIG: join(this.directory, '.npmrc'),
            NPM_CONFIG_GLOBALCONFIG: join(this.directory, '.npmrc-global')
          })
    }
  }

  execute(args: string[], env = this.environment()): Promise<{ stdout: string; stderr: string }> {
    this.signal.throwIfAborted()
    return execute(this.executable, args, {
      env,
      windowsHide: true,
      timeout: 10000,
      signal: this.signal
    })
  }

  async getPackageVersion(name: string): Promise<string | null> {
    this.validatePackage(name, '')
    try {
      if (this.kind === 'node') {
        const data = JSON.parse(
          await readFile(
            join(this.directory, 'packages/node_modules', name, 'package.json'),
            'utf8'
          )
        )
        return typeof data.version === 'string' ? data.version : null
      }
      const { stdout } = await this.execute([
        '-c',
        'import sys; from importlib.metadata import version; print(version(sys.argv[1]))',
        name
      ])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  install(status: (message: string) => void = () => {}): Promise<void> {
    this.signal.throwIfAborted()
    if (!this.installation) {
      this.installation = (async () => {
        if (this.kind === 'node') {
          await this.downloadNode(status)
          await this.execute([this.npm, '--version'])
          return
        }
        await this.downloadPython(status)
        this.signal.throwIfAborted()
        try {
          await this.execute(['-m', 'uv', '--version'])
        } catch {
          status(t('runtime.installingUv'))
          await this.runInstaller(['-m', 'pip', 'install', 'uv'], status)
        }
      })().catch((error) => {
        this.installation = undefined
        throw error
      })
    }
    return this.installation
  }

  async installPackage(
    name: string,
    version: string,
    reinstall: boolean,
    status: (message: string) => void
  ): Promise<void> {
    this.validatePackage(name, version)
    await this.install(status)
    if (this.kind === 'node') {
      await mkdir(join(this.directory, 'packages'), { recursive: true })
      await this.runInstaller(
        [
          this.npm,
          'install',
          '--prefix',
          join(this.directory, 'packages'),
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          ...(reinstall ? ['--force'] : []),
          name + '@' + (version || 'latest')
        ],
        status
      )
      return
    }
    await this.runInstaller(
      [
        '-m',
        'uv',
        'pip',
        'install',
        '--native-tls',
        '--python',
        this.executable,
        ...(reinstall ? ['--reinstall', '--no-cache'] : []),
        ...(version ? [name + '==' + version] : [name, '--upgrade'])
      ],
      status
    )
  }

  async uninstallPackage(
    name: string,
    status: (message: string) => void = () => {}
  ): Promise<void> {
    this.validatePackage(name, '')
    this.signal.throwIfAborted()
    const exists = await access(this.executable).then(
      () => true,
      () => false
    )
    if (!exists) return
    await this.runInstaller(
      this.kind === 'python'
        ? ['-m', 'uv', 'pip', 'uninstall', '--python', this.executable, name]
        : [
            this.npm,
            'uninstall',
            '--prefix',
            join(this.directory, 'packages'),
            '--no-audit',
            '--no-fund',
            '--package-lock=false',
            name
          ],
      status
    )
  }

  private validatePackage(name: string, version: string): void {
    const valid =
      this.kind === 'python'
        ? /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
        : /^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/
    if (!valid.test(name) || (version && !/^[a-zA-Z0-9][a-zA-Z0-9.!+_-]{0,99}$/.test(version)))
      throw new Error('Invalid package name or version')
  }

  private async downloadNode(status: (message: string) => void): Promise<void> {
    try {
      await access(join(this.directory, '.complete'))
      await this.execute(['--version'])
      return
    } catch {
      /* Install an absent or interrupted runtime. */
    }
    const target = (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch
    if (!nodeChecksums[target])
      throw new Error('This platform does not have a packaged Node runtime.')
    const filename = `node-v${nodeVersion}-${target}`
    const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
    const archive = join(this.root, 'node.' + randomUUID() + extension)
    const staging = join(this.root, 'node.' + randomUUID())
    await mkdir(staging, { recursive: true })
    try {
      status(t('runtime.downloadingNode'))
      await this.download(
        `https://nodejs.org/dist/v${nodeVersion}/${filename}${extension}`,
        archive,
        nodeChecksums[target]
      )
      if (process.platform === 'win32') await extractZip(archive, { dir: staging })
      else await extract({ cwd: staging, file: archive, strict: true })
      this.signal.throwIfAborted()
      await rm(this.directory, { recursive: true, force: true })
      await rename(join(staging, filename), this.directory)
      await this.execute(['--version'])
      await writeFile(join(this.directory, '.npmrc'), '', { mode: 0o600 })
      await writeFile(join(this.directory, '.npmrc-global'), '', { mode: 0o600 })
      await writeFile(join(this.directory, '.complete'), '', { mode: 0o600 })
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async download(url: string, archive: string, checksum: string): Promise<void> {
    try {
      const profile = session.fromPartition('runtime-downloads')
      const proxyRules = ['http', 'https']
        .map((protocol) => {
          const proxy =
            process.env[protocol + '_proxy'] ||
            process.env[protocol.toUpperCase() + '_PROXY'] ||
            process.env.all_proxy ||
            process.env.ALL_PROXY
          return proxy ? `${protocol}=${proxy}` : ''
        })
        .filter(Boolean)
        .join(';')
      if (proxyRules)
        await profile.setProxy({
          proxyRules,
          proxyBypassRules: process.env.no_proxy || process.env.NO_PROXY
        })
      const response = await profile.fetch(url, { signal: this.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      if (!response.body) throw new Error('Response has no body.')
      const hash = createHash('sha256')
      const check = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as never),
        check,
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        { signal: this.signal }
      )
      if (hash.digest('hex') !== checksum) throw new Error('Runtime checksum mismatch.')
      this.signal.throwIfAborted()
    } catch (error) {
      this.signal.throwIfAborted()
      throw new Error(`Runtime download failed: ${describeDownloadError(error)}`, { cause: error })
    }
  }

  private async downloadPython(status: (message: string) => void): Promise<void> {
    try {
      await access(join(this.directory, '.complete'))
      await this.execute(['--version'])
      return
    } catch {
      /* Install an absent or interrupted Python runtime. */
    }
    const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
    const platform = {
      darwin: 'apple-darwin',
      win32: 'pc-windows-msvc',
      linux: 'unknown-linux-gnu'
    }[process.platform]
    const target = arch + '-' + platform
    if (!pythonChecksums[target])
      throw new Error('This platform does not have a packaged Python runtime.')
    await mkdir(this.root, { recursive: true })
    const archive = join(this.root, 'python.' + randomUUID() + '.tar.gz')
    try {
      status(t('runtime.downloadingPython'))
      await this.download(
        'https://github.com/astral-sh/python-build-standalone/releases/download/20260310/cpython-3.12.13+20260310-' +
          target +
          '-install_only.tar.gz',
        archive,
        pythonChecksums[target]
      )
      await rm(this.directory, { recursive: true, force: true })
      await extract({ cwd: this.root, file: archive, strict: true })
      await this.execute(['--version'])
      await writeFile(join(this.directory, '.complete'), '', { mode: 0o600 })
    } finally {
      await rm(archive, { force: true })
    }
  }

  private runInstaller(args: string[], status: (message: string) => void): Promise<void> {
    this.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      let lastLine = ''
      const handle = this.start(args, {
        cwd: this.directory,
        output: (data) => {
          this.record(data)
          const text = data.trim()
          if (text) {
            lastLine = text.split(/\r?\n/).at(-1)!.slice(-1000)
            status(lastLine)
          }
        }
      })
      let failure: Error | undefined
      handle.process.once('error', (error) => {
        failure = error
      })
      handle.process.once('close', (code) => {
        if (this.signal.aborted) reject(this.signal.reason)
        else if (failure) reject(failure)
        else if (code === 0) resolve()
        else reject(new Error(lastLine || 'Package installation failed. See application logs.'))
      })
    })
  }

  private record(data: string): void {
    log.info('[runtime] ' + data)
    this.output(data)
  }

  start(
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; output?: (data: string) => void } = {}
  ): RuntimeProcess {
    this.signal.throwIfAborted()
    const child = spawn(this.executable, args, {
      cwd: options.cwd,
      env: options.env ?? this.environment(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let exited = false
    const output = options.output ?? ((data: string) => this.record(data))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.on('error', () => {
      exited = true
      this.children.delete(handle)
    })
    child.on('exit', () => {
      exited = true
      this.children.delete(handle)
    })
    let stopping: Promise<void> | undefined
    const handle: RuntimeProcess = {
      process: child,
      get exited() {
        return exited
      },
      stop: () => {
        if (!stopping)
          stopping = (async () => {
            this.children.delete(handle)
            if (!child.pid || exited) return
            if (process.platform === 'win32') {
              await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true
              }).catch(() => {})
            } else {
              try {
                process.kill(-child.pid, 'SIGTERM')
              } catch {
                return
              }
              await new Promise<void>((resolve) => {
                const done = (): void => {
                  clearTimeout(timer)
                  child.removeListener('exit', done)
                  resolve()
                }
                const timer = setTimeout(done, 5000)
                child.once('exit', done)
                if (exited) done()
              })
              try {
                process.kill(-child.pid, 'SIGKILL')
              } catch {
                /* already stopped */
              }
            }
          })()
        return stopping
      }
    }
    this.children.add(handle)
    return handle
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await Promise.all([...this.children].map((child) => child.stop()))
    await this.installation?.catch(() => {})
  }
}
