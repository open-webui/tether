export interface LocalServerConfig {
  enabled: boolean
  version: string
  autoUpdate: boolean
  httpEnabled: boolean
  httpHost: '127.0.0.1' | '0.0.0.0'
  homeDirectory?: string
  env?: Record<string, string>
}

export interface GeneralConfig {
  language: string
  deviceName: string
  theme: 'system' | 'light' | 'dark'
  uiScale: number
  automaticUpdates: boolean
  startMinimized: boolean
  runInBackground: boolean
  showMenuBarIcon: boolean
  globalShortcut: string
  spotlightShortcut: string
  spotlightClipboardPaste: boolean
  spotlightPosition: { x: number; y: number } | null
  windowBounds: { x: number; y: number; width: number; height: number } | null
  windowMaximized: boolean
}

export const uiScaleOptions = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export const defaultGeneralConfig: GeneralConfig = {
  language: '',
  deviceName: '',
  theme: 'system',
  uiScale: 1,
  automaticUpdates: true,
  startMinimized: false,
  runInBackground: true,
  showMenuBarIcon: true,
  globalShortcut: 'CommandOrControl+Shift+T',
  spotlightShortcut: 'CommandOrControl+Shift+I',
  spotlightClipboardPaste: false,
  spotlightPosition: null,
  windowBounds: null,
  windowMaximized: false
}

export function parseGeneralConfig(value: unknown): GeneralConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid settings')
  const config = { ...defaultGeneralConfig, ...value } as GeneralConfig
  if (
    typeof config.deviceName !== 'string' ||
    config.deviceName.trim().length > 100 ||
    Array.from(config.deviceName).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Device name must be at most 100 characters without control characters.')
  if (
    typeof config.language !== 'string' ||
    !/^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/.test(config.language)
  )
    throw new Error('Invalid language')
  if (!['system', 'light', 'dark'].includes(config.theme)) throw new Error('Invalid appearance')
  if (!uiScaleOptions.includes(config.uiScale)) throw new Error('Invalid UI scale')
  for (const key of [
    'automaticUpdates',
    'startMinimized',
    'runInBackground',
    'showMenuBarIcon',
    'spotlightClipboardPaste',
    'windowMaximized'
  ] as const) {
    if (typeof config[key] !== 'boolean') throw new Error(`Invalid setting: ${key}`)
  }
  for (const key of ['globalShortcut', 'spotlightShortcut'] as const) {
    if (typeof config[key] !== 'string' || config[key].length > 200 || config[key].includes('\0'))
      throw new Error('Invalid keyboard shortcut')
  }
  const position = config.spotlightPosition
  if (
    position !== null &&
    (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y))
  )
    throw new Error('Invalid Spotlight position')
  const bounds = config.windowBounds
  if (
    bounds !== null &&
    (!bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(
        (value) => Number.isInteger(value) && Math.abs(value) <= 2_147_483_647
      ) ||
      bounds.width < 480 ||
      bounds.height < 360)
  )
    throw new Error('Invalid window bounds')
  return {
    language: config.language,
    deviceName: config.deviceName.trim(),
    theme: config.theme,
    uiScale: config.uiScale,
    automaticUpdates: config.automaticUpdates,
    startMinimized: config.startMinimized,
    runInBackground: config.runInBackground,
    showMenuBarIcon: config.showMenuBarIcon,
    globalShortcut: config.globalShortcut.trim(),
    spotlightShortcut: config.spotlightShortcut.trim(),
    spotlightClipboardPaste: config.spotlightClipboardPaste,
    spotlightPosition: position === null ? null : { x: position.x, y: position.y },
    windowBounds:
      bounds === null
        ? null
        : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    windowMaximized: config.windowMaximized
  }
}

export interface AppConfig extends GeneralConfig {
  localServer: LocalServerConfig
}

export interface RuntimeState {
  version: string | null
  ipcSupported?: boolean
  status: string
  busy: boolean
  error: string
}

export function parseLocalServerConfig(value: unknown): LocalServerConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid Open Terminal settings')
  const config = value as LocalServerConfig
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean')
    throw new Error('Invalid Open Terminal settings')
  if (typeof config.version !== 'string' || typeof config.autoUpdate !== 'boolean')
    throw new Error('Invalid Open Terminal settings')
  if (config.httpEnabled !== undefined && typeof config.httpEnabled !== 'boolean')
    throw new Error('Invalid HTTP setting')
  if (config.httpHost !== undefined && !['127.0.0.1', '0.0.0.0'].includes(config.httpHost))
    throw new Error('Invalid HTTP bind address')
  if (
    config.homeDirectory !== undefined &&
    (typeof config.homeDirectory !== 'string' || config.homeDirectory.includes('\0'))
  )
    throw new Error('Invalid home directory')
  const version = config.version.trim() === 'latest' ? '' : config.version.trim()
  if (version && !/^[a-zA-Z0-9][a-zA-Z0-9.!+_-]{0,99}$/.test(version))
    throw new Error('Enter an Open Terminal version or leave it blank for latest.')
  const env = config.env
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env))
      throw new Error('Invalid environment variables')
    const names = new Set<string>()
    for (const [name, value] of Object.entries(env)) {
      if (
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
        typeof value !== 'string' ||
        value.includes('\0')
      )
        throw new Error('Environment variables need a valid name and text value.')
      const normalized = name.toUpperCase()
      if (names.has(normalized)) throw new Error(`Duplicate environment variable: ${name}`)
      names.add(normalized)
      if (
        [
          'OPEN_TERMINAL_API_KEY',
          'OPEN_TERMINAL_API_KEY_FILE',
          'OPEN_TERMINAL_HOST',
          'OPEN_TERMINAL_PORT',
          'OPEN_TERMINAL_ISOLATED',
          'OPEN_TERMINAL_CONFIG',
          'OPEN_TERMINAL_CONFIG_PATH',
          'OPEN_TERMINAL_MULTI_USER',
          'OPEN_TERMINAL_ENABLE_NOTEBOOKS',
          'OPEN_TERMINAL_CORS_ALLOWED_ORIGINS',
          'OPEN_TERMINAL_LOG_DIR'
        ].includes(normalized)
      )
        throw new Error(`${name} is managed by Tether.`)
    }
  }
  return {
    enabled: config.enabled ?? false,
    version,
    autoUpdate: config.autoUpdate,
    httpEnabled: config.httpEnabled ?? false,
    httpHost: config.httpHost ?? '127.0.0.1',
    homeDirectory: config.homeDirectory?.trim() ?? '',
    ...(env === undefined ? {} : { env: { ...env } })
  }
}
