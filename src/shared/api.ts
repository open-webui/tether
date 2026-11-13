import type { AppConfig, RuntimeState } from './config'
import type { ConnectionState } from './connections'
import type { TerminalTarget, TerminalOutput } from './terminal'
import type { UpdateState } from './updater'
import type {
  UserConnectionCheck,
  UserConnectionInfo,
  UserConnectionInput,
  UserConnectionType
} from './userConnections'

export interface AppInfo {
  deviceName: string
  homeDirectory: string
  name: string
  version: string
  platform: NodeJS.Platform
}

export interface TooltipInfo {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface TetherAPI {
  openSpotlight: () => Promise<void>
  onShowConnection: (callback: () => void) => () => void
  setTooltip: (tooltip: TooltipInfo | null) => Promise<void>
  onWindowVisibility: (callback: (visible: boolean) => void) => () => void
  setTerminalHeight: (height: number) => Promise<void>
  connectTerminal: (
    target: TerminalTarget,
    output: (message: TerminalOutput, consumed: () => void) => void
  ) => number
  disconnectTerminal: (id: number) => void
  writeTerminal: (id: number, data: string) => void
  resizeTerminal: (id: number, cols: number, rows: number) => void
  setSettingsOpen: (open: boolean) => Promise<void>
  getConfig: () => Promise<AppConfig>
  selectDirectory: () => Promise<string | null>
  onConfigChanged: (callback: (config: AppConfig) => void) => () => void
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>
  setConfig: (config: Partial<AppConfig>) => Promise<void>
  getRuntimeState: () => Promise<RuntimeState>
  installPackage: () => Promise<void>
  uninstallPackage: () => Promise<void>
  restartTerminal: () => Promise<void>
  copyTerminalCredentials: () => Promise<void>
  onRuntimeState: (callback: (state: RuntimeState) => void) => () => void
  listConnections: () => Promise<ConnectionState>
  addConnection: (input: {
    name: string
    url: string
    installTerminal?: boolean
  }) => Promise<ConnectionState>
  updateConnection: (id: string, input: { name: string; url: string }) => Promise<ConnectionState>
  selectConnection: (id: string | null) => Promise<void>
  reloadConnection: () => Promise<void>
  removeConnection: (id: string) => Promise<void>
  onConnectionState: (callback: (state: ConnectionState) => void) => () => void
  listUserConnections: () => Promise<UserConnectionInfo[]>
  saveUserConnection: (
    id: string | null,
    input: UserConnectionInput
  ) => Promise<UserConnectionInfo[]>
  removeUserConnection: (id: string) => Promise<UserConnectionInfo[]>
  // `key` blank with `id` set: use that connection's saved key.
  verifyUserConnection: (input: {
    type: UserConnectionType
    url: string
    key?: string
    id?: string
  }) => Promise<UserConnectionCheck>
  resetApp: () => Promise<void>
  getAppInfo: () => Promise<AppInfo>
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdateState: (callback: (state: UpdateState) => void) => () => void
}
