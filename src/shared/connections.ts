import type { ServiceStatus } from './terminal'
import type { GeneralConfig } from './config'
import type { TetherEvent } from './events'

export interface Connection {
  id: string
  name: string
  url: string
  trustedCertificate?: string
}

export interface ConnectionState {
  connections: Connection[]
  selected: string | null
  title: string
  terminalStatus: ServiceStatus
  webuiConnected: boolean
  errors: Record<string, string>
  persistentCredentials: boolean
}

export interface AccessToken {
  token: string
  expiresAt: number | null
}

export interface TetherBridge {
  version: 1
  isFocused(): Promise<boolean>
  focus(): Promise<void>
  signedIn(token: string): Promise<AccessToken>
  refresh(force?: boolean): Promise<AccessToken | null>
  signedOut(): Promise<void>
  onToken(callback: (access: AccessToken | null) => void): () => void
  onEvent(
    callback: (
      event: TetherEvent | { type: 'theme:update'; data: { theme: GeneralConfig['theme'] } }
    ) => Promise<void>
  ): () => void
}

export function normalizeURL(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS WebUI address without embedded credentials.')
  }
  if (url.search || url.hash) throw new Error('Use the WebUI address without a query or fragment.')
  return url.href.replace(/\/+$/, '')
}

export function endpoint(url: string, path: string): string {
  return url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

export const connectionRedirectError =
  'WebUI redirects to a different address. Edit the connection to use its final address, including https:// if required.'

export async function validateConnectionURL(
  value: string,
  fetch: (url: string, options: RequestInit) => Promise<Response>
): Promise<string> {
  const url = normalizeURL(value.trim())
  const signal = AbortSignal.timeout(15000)
  const request = async (address: string): Promise<Response> => {
    try {
      return await fetch(address, { redirect: 'manual', credentials: 'omit', signal })
    } catch {
      throw new Error('Could not reach WebUI. Check the address, HTTP/HTTPS, and your network.')
    }
  }

  // Check the page too: its redirects can differ from those of the API.
  let address = url
  for (let redirects = 0; ; redirects++) {
    const response = await request(address)
    await response.body?.cancel()
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirects >= 5)
        throw new Error('WebUI has a broken redirect. Check the address.')
      address = new URL(location, address).href
      if (!belongsToConnection(address, url)) throw new Error(connectionRedirectError)
      continue
    }
    if (!response.ok)
      throw new Error(`Could not load WebUI (HTTP ${response.status}). Check the address.`)
    break
  }

  const response = await request(endpoint(url, 'api/config'))
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status >= 300 && response.status < 400) throw new Error(connectionRedirectError)
    throw new Error(`Could not reach the WebUI API (HTTP ${response.status}). Check the address.`)
  }
  const config = await response.json().catch(() => null)
  if (
    config?.status !== true ||
    typeof config?.name !== 'string' ||
    !config?.features ||
    typeof config.features !== 'object' ||
    Array.isArray(config.features)
  ) {
    throw new Error(
      'This address did not return a valid Open WebUI configuration. Check the WebUI address.'
    )
  }
  return url
}

export function belongsToConnection(address: string, connectionURL: string): boolean {
  try {
    const actual = new URL(address)
    const expected = new URL(connectionURL)
    const root = expected.pathname.replace(/\/+$/, '')
    return (
      actual.origin === expected.origin &&
      (actual.pathname === root || actual.pathname.startsWith(root + '/'))
    )
  } catch {
    return false
  }
}
