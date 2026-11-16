import {
  parseConnectionSettings,
  normalizeServiceURL,
  parseConnectionKey,
  type ConnectionSettings
} from './connectionSettings'

type McpTransport =
  | { transport: 'stdio'; command: string; args: string[]; cwd?: string }
  | { transport: 'streamable-http'; url: string }

type ToolEndpoint = { type: 'openapi' | 'terminal'; url: string } | ({ type: 'mcp' } & McpTransport)
export type ToolConnection = ConnectionSettings & ToolEndpoint
export type ToolConnectionInfo = ToolConnection & { hasKey: boolean; hasEnvironment: boolean }
export interface ToolSecrets {
  key?: string
  env?: Record<string, string>
}
export type ToolConnectionInput = Omit<ConnectionSettings, 'id'> & ToolEndpoint & ToolSecrets

export function parseToolConnection(value: unknown): ToolConnection {
  const base = parseConnectionSettings(value)
  const { type, transport, command, args, cwd, url } = value as Record<string, unknown>
  if (type === 'openapi' || type === 'terminal')
    return { ...base, type, url: normalizeServiceURL(url) }
  if (type !== 'mcp') throw new Error('Invalid tool connection type')
  if (transport === 'stdio') {
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 4096 ||
      /[\0\r\n]/.test(command)
    )
      throw new Error('Enter an executable, with arguments in the arguments field.')
    if (
      !Array.isArray(args) ||
      args.length > 256 ||
      args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      JSON.stringify(args).length > 65536
    )
      throw new Error('Arguments must be a JSON array of strings (at most 64 KB).')
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 4096 || /[\0\r\n]/.test(cwd)))
      throw new Error('Invalid working directory.')
    return {
      ...base,
      type,
      transport,
      command: command.trim(),
      args,
      cwd: (cwd as string | undefined) || undefined
    }
  }
  if (transport !== 'streamable-http') throw new Error('Choose an MCP transport.')
  return { ...base, type, transport, url: normalizeServiceURL(url, true) }
}

// Omitted fields keep saved secrets; empty values clear them.
export function parseToolSecrets(value: ToolSecrets, previous: ToolSecrets = {}): ToolSecrets {
  return {
    key: value.key === undefined ? previous.key : parseConnectionKey(value.key),
    env: value.env === undefined ? previous.env : parseMcpEnvironment(value.env)
  }
}

export function parseMcpEnvironment(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 100
  )
    throw new Error('Environment must be a JSON object of names and string values.')
  const entries = Object.entries(value)
  if (
    entries.some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')
    ) ||
    JSON.stringify(value).length > 65536
  )
    throw new Error('Invalid environment (at most 64 KB).')
  return Object.fromEntries(entries) as Record<string, string>
}
