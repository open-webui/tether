import { belongsToConnection, type Connection } from './connections'

export function parseConnectionHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid custom headers.')
  const headers = new Map<string, string>()
  let size = 0
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim().toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || headers.has(name))
      throw new Error('Use unique, valid HTTP header names.')
    if (
      /^(authorization|cookie2?|host|connection|keep-alive|content-.*|transfer-encoding|upgrade|te|trailer|origin|referer|proxy-.*|sec-.*)$/i.test(
        name
      )
    )
      throw new Error(
        'Authentication and transport headers are managed by Tether. Use a custom gateway header instead.'
      )
    if (typeof raw !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(raw))
      throw new Error(
        'Header values must contain only HTTP header characters, without line breaks.'
      )
    const text = raw.trim()
    size += name.length + text.length
    if (headers.size >= 16 || size > 16384)
      throw new Error('Use at most 16 custom headers, totaling at most 16 KB.')
    headers.set(name, text)
  }
  return Object.fromEntries([...headers].sort(([a], [b]) => a.localeCompare(b)))
}

export function connectionHeaders(connection: Connection, address: string): Record<string, string> {
  try {
    const url = new URL(address)
    if (url.protocol === 'wss:') url.protocol = 'https:'
    else if (url.protocol === 'ws:') url.protocol = 'http:'
    return belongsToConnection(url.href, connection.url) ? { ...connection.headers } : {}
  } catch {
    return {}
  }
}
