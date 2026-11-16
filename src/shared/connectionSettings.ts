export interface ConnectionSettings {
  id: string
  name: string
  enabled: boolean
}

export function parseConnectionSettings(value: unknown): ConnectionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid connection')
  const { id, name, enabled } = value as Record<string, unknown>
  if (typeof id !== 'string' || !/^[a-z0-9]{1,24}$/.test(id))
    throw new Error('Invalid connection id')
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 100 ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('Enter a connection name of at most 100 characters.')
  if (typeof enabled !== 'boolean') throw new Error('Invalid connection setting')
  return { id, name: name.trim(), enabled }
}

export function normalizeServiceURL(value: unknown, exact = false): string {
  let url: URL
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error('Enter a valid URL, starting with http:// or https://.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Enter an HTTP or HTTPS URL without embedded credentials.')
  if (url.search || url.hash) throw new Error('Use the URL without a query or fragment.')
  return exact ? url.href : url.href.replace(/\/+$/, '')
}

export function parseConnectionKey(value: unknown): string {
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
