import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { finished } from 'node:stream/promises'
import type { PtyExit, PtyProcess, ServiceLaunch } from '../process/managedService'
import { SandboxError, type SandboxPolicy } from './policy'
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1'

export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&') + '"'
}

export async function spawnMxc(launch: ServiceLaunch, policy: SandboxPolicy): Promise<PtyProcess> {
  const { spawnWithPty, probe } = await import('@microsoft/mxc-sdk/v1')
  const system = process.env.SystemRoot || 'C:\\Windows'
  const deniedPaths: string[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\'
    if (
      await access(root).then(
        () => true,
        () => false
      )
    )
      deniedPaths.push(root)
  }
  const request: ContainerRequest = {
    containment: { type: 'processcontainer' },
    containerName: 'tether-' + randomUUID(),
    command: [launch.file, ...launch.args].map(quoteWindowsArgument).join(' '),
    workingDirectory: policy.workspacePath,
    environment: launch.env,
    inheritDefaultEnvironment: false,
    filesystem: {
      deniedPaths,
      readonlyPaths: [join(system, 'System32'), join(system, 'WinSxS'), policy.runtimePath],
      readwritePaths: [policy.workspacePath, policy.sessionPath],
      clearPolicyOnExit: true
    },
    network: {
      egress: { default: policy.networkAccess ? 'allow' : 'deny' },
      ingress: { default: 'deny', hostLoopback: 'deny' }
    },
    ui: { disable: true, clipboard: 'none', allowInputInjection: false }
  }
  const support = probe(request)
  if (
    support.error ||
    support.tier !== 'base-container' ||
    support.needsDaclAugmentation ||
    !support.probes.baseContainerSupportsDenyPaths
  )
    throw new SandboxError(
      'This Windows version cannot enforce the sandbox policy without a weaker fallback.'
    )
  const child = await spawnWithPty(request, {
    size: { rows: 50, columns: 200 },
    telemetry: { enabled: false }
  })
  if (child.warnings.length) {
    child.kill()
    try {
      await child.wait()
    } finally {
      child.dispose()
    }
    throw new SandboxError(
      'MXC could not apply the sandbox without warnings. No session was started.'
    )
  }
  const output = child.output
  const input = child.input
  output.setEncoding('utf8')
  output.pause()
  let exit: PtyExit | undefined
  const listeners = new Set<(event: PtyExit) => void>()
  const complete = (result: PtyExit): void => {
    exit = result
    for (const listener of listeners) listener(exit)
    child.dispose()
  }
  // Deliver buffered diagnostics before exit listeners detach and dispose the PTY.
  void Promise.allSettled([
    child.wait(),
    finished(output, { readable: true, writable: false, cleanup: true })
  ]).then(([result, drained]) => {
    const failure = result.status === 'rejected' ? result : drained
    complete({
      exitCode: result.status === 'fulfilled' ? result.value.exitCode : 1,
      ...(failure.status === 'rejected'
        ? {
            error: `MXC process failed: ${
              failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
            }`
          }
        : {})
    })
  })
  return {
    pid: child.id,
    onData(callback) {
      output.on('data', callback)
      output.resume()
      return {
        dispose: () => {
          output.off('data', callback)
        }
      }
    },
    onExit(callback) {
      listeners.add(callback)
      if (exit)
        queueMicrotask(() => {
          if (listeners.has(callback)) callback(exit!)
        })
      return {
        dispose: () => {
          listeners.delete(callback)
        }
      }
    },
    write: (data) => {
      input.write(data)
    },
    resize: (cols, rows) => child.resize({ columns: cols, rows }),
    kill: () => {
      if (!exit) child.kill()
    }
  }
}
