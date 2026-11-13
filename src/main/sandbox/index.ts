import { app } from 'electron'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxSupport } from '../../shared/sandbox'
import type { PtyProcess, ServiceLaunch } from '../process/managedService'
import { spawnPty } from '../process/nativePty'
import { seatbeltLaunch } from './seatbelt'
import { SandboxError, verifyWorkspace, type SandboxPolicy } from './policy'

// Native library loaders cannot resolve Electron's virtual ASAR paths.
if (process.platform === 'win32' && app.isPackaged)
  process.env.MXC_FFI_DIR = join(
    process.resourcesPath,
    'app.asar.unpacked/node_modules/@microsoft/mxc-sdk/bin',
    process.arch
  )

export function sandboxForbiddenPaths(): string[] {
  return [app.getPath('userData'), app.getAppPath(), process.resourcesPath]
}

export async function getSandboxSupport(): Promise<SandboxSupport> {
  try {
    if (process.platform === 'darwin') {
      await access('/usr/bin/sandbox-exec', constants.X_OK)
      return { supported: true, backend: 'seatbelt' }
    }
    if (process.platform === 'linux') {
      return { supported: false, reason: 'Workspace sandboxing is not available on Linux.' }
    }
    if (process.platform === 'win32') {
      const { probe } = await import('@microsoft/mxc-sdk/v1')
      const support = probe()
      const supported =
        !support.error &&
        support.tier === 'base-container' &&
        support.probes.baseContainerSupportsDenyPaths &&
        Object.values(support.probes.uiCapabilities).every(Boolean)
      return {
        backend: 'processcontainer',
        supported,
        reason: supported
          ? undefined
          : 'This Windows version lacks the required ProcessContainer protections. No administrator-based or weaker fallback is used.'
      }
    }
    return { supported: false, reason: 'Sandboxing is not supported on this operating system.' }
  } catch (error) {
    return {
      supported: false,
      reason: `Sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export async function spawnSandboxed(
  launch: ServiceLaunch,
  policy: SandboxPolicy,
  signal: AbortSignal
): Promise<PtyProcess> {
  signal.throwIfAborted()
  if (
    !(
      (process.platform === 'darwin' && policy.backend === 'seatbelt') ||
      (process.platform === 'win32' && policy.backend === 'processcontainer')
    )
  )
    throw new SandboxError('The requested sandbox is not supported on this operating system.')
  await verifyWorkspace(policy)
  signal.throwIfAborted()
  if (policy.backend === 'processcontainer') {
    const { spawnMxc } = await import('./mxc')
    // ManagedService owns even a process returned after cancellation and terminates it.
    return spawnMxc(launch, policy)
  }
  const command = seatbeltLaunch(launch, policy)
  signal.throwIfAborted()
  try {
    return spawnPty(command)
  } catch (error) {
    throw new SandboxError(`Could not start the sandbox: ${String(error)}`)
  }
}
