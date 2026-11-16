import {
  parseConnectionSettings,
  normalizeServiceURL,
  type ConnectionSettings
} from './connectionSettings'

// Inference endpoints reached from this computer.
export interface ProviderConnection extends ConnectionSettings {
  type: 'openai'
  url: string
}
export interface ProviderConnectionInfo extends ProviderConnection {
  hasKey: boolean
}
export type ProviderConnectionInput = Omit<ProviderConnection, 'id'> & { key?: string }

export function parseProviderConnection(value: unknown): ProviderConnection {
  const base = parseConnectionSettings(value)
  const { type, url } = value as Record<string, unknown>
  if (type !== 'openai') throw new Error('Invalid inference connection type')
  return { ...base, type, url: normalizeServiceURL(url) }
}
