// Connections Tether makes on Open WebUI's behalf. Their keys never leave this computer.
export const userConnectionTypes = ['openai', 'openapi', 'terminal'] as const

export type UserConnectionType = (typeof userConnectionTypes)[number]

export interface UserConnection {
  id: string
  name: string
  type: UserConnectionType
  url: string
  enabled: boolean
}

export interface UserConnectionInfo extends UserConnection {
  hasKey: boolean
}

// `key` left out keeps the saved key; an empty string removes it.
export type UserConnectionInput = Omit<UserConnection, 'id'> & { key?: string }

export function parseUserConnection(value: unknown): UserConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid connection')
  const { id, name, type, url, enabled } = value as Record<string, unknown>
  // Forms the relay service name `c_<id>`.
  if (typeof id !== 'string' || !/^[a-z0-9]{1,24}$/.test(id))
    throw new Error('Invalid connection id')
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 100 ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('Enter a connection name of at most 100 characters.')
  if (!userConnectionTypes.includes(type as UserConnectionType))
    throw new Error('Invalid connection type')
  if (typeof enabled !== 'boolean') throw new Error('Invalid connection setting')
  return {
    id,
    name: name.trim(),
    type: type as UserConnectionType,
    url: normalizeUserConnectionURL(url),
    enabled
  }
}

export function normalizeUserConnectionURL(value: unknown): string {
  let url: URL
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error('Enter a valid URL, starting with http:// or https://.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Enter an HTTP or HTTPS URL without embedded credentials.')
  if (url.search || url.hash) throw new Error('Use the URL without a query or fragment.')
  return url.href.replace(/\/+$/, '')
}

export function parseUserConnectionKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Invalid key')
  return value.trim()
}
