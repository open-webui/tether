import type { RelayDestination } from './relay'

// The remote peer gets one logical endpoint, never an arbitrary local path.
export function mcpDestination(
  url: string,
  key: string,
  path: string,
  websocket: boolean
): RelayDestination {
  if (websocket || path !== '/') throw new Error('Invalid MCP endpoint.')
  const endpoint = new URL(url)
  return {
    url: endpoint.origin,
    path: endpoint.pathname,
    headers: key ? { Authorization: 'Bearer ' + key } : {},
    exact: true
  }
}
