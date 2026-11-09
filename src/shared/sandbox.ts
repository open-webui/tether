export interface SandboxConfig {
  enabled: boolean
  workspacePath: string
  networkAccess: boolean
}

export type SandboxBackend = 'seatbelt' | 'processcontainer'

export interface SandboxSupport {
  supported: boolean
  backend?: SandboxBackend
  reason?: string
}

export interface SandboxState {
  active: boolean
  support: SandboxSupport
  workspacePath: string
  networkAccess: boolean
  policyRevision: number
  error?: string
}

export function parseSandboxConfig(value: unknown): SandboxConfig {
  if (value === undefined) return { enabled: false, workspacePath: '', networkAccess: false }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid sandbox settings.')
  const config = value as Record<string, unknown>
  if (
    Object.keys(config).some(
      (key) => !['enabled', 'workspacePath', 'networkAccess'].includes(key)
    ) ||
    typeof config.enabled !== 'boolean' ||
    (config.networkAccess !== undefined && typeof config.networkAccess !== 'boolean') ||
    typeof config.workspacePath !== 'string' ||
    Array.from(config.workspacePath).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Invalid sandbox settings.')
  if (config.enabled && !config.workspacePath.trim())
    throw new Error('Choose a workspace folder before enabling the sandbox.')
  return {
    enabled: config.enabled,
    workspacePath: config.workspacePath.trim(),
    networkAccess: config.networkAccess === true
  }
}

export function sandboxConfigChanged(a: SandboxConfig, b: SandboxConfig): boolean {
  return (
    a.enabled !== b.enabled ||
    a.workspacePath !== b.workspacePath ||
    a.networkAccess !== b.networkAccess
  )
}

export function isSandboxEnvironmentVariable(name: string): boolean {
  return /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PATH|PATHEXT|SHELL|COMSPEC|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|XDG_.*|PYTHON.*|PIP_.*|UV_.*|NPM_CONFIG_.*|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|.*PROXY|SSH_.*|DISPLAY|WAYLAND_DISPLAY|DBUS_.*|BASH_ENV|ENV|ZDOTDIR)$/i.test(
    name
  )
}
