import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, RuntimeState } from '../shared/config'
import type { TetherAPI } from '../shared/api'
import type { UpdateState } from '../shared/updater'

import { createTerminalClient } from './terminalClient'

const terminals = createTerminalClient((target, id) =>
  ipcRenderer.send('terminal:connect', target, id)
)
window.addEventListener('unload', () => terminals.dispose())
ipcRenderer.on('terminal:port', (event, id: number) => {
  const [port] = event.ports
  if (port) terminals.accept(id, port)
})

const api: TetherAPI = {
  openSpotlight: () => ipcRenderer.invoke('spotlight:open'),
  onShowConnection: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('connections:show', listener)
    return () => ipcRenderer.removeListener('connections:show', listener)
  },
  setTooltip: (tooltip) => ipcRenderer.invoke('window:tooltip', tooltip),
  onWindowVisibility: (callback) => {
    let active = true
    let received = false
    const handler = (_event: Electron.IpcRendererEvent, visible: boolean): void => {
      received = true
      callback(visible)
    }
    ipcRenderer.on('window:visibility', handler)
    void ipcRenderer
      .invoke('window:visibility')
      .then((visible) => {
        if (active && !received) callback(visible)
      })
      .catch(() => {
        /* The window may have closed during initialization. */
      })
    return () => {
      active = false
      ipcRenderer.removeListener('window:visibility', handler)
    }
  },
  setTerminalHeight: (height) => ipcRenderer.invoke('terminal:height', height),
  connectTerminal: terminals.connect,
  disconnectTerminal: terminals.disconnect,
  writeTerminal: terminals.write,
  resizeTerminal: terminals.resize,
  setSettingsOpen: (open) => ipcRenderer.invoke('settings:open', open),
  getConfig: () => ipcRenderer.invoke('config:get'),
  onConfigChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig): void => callback(config)
    ipcRenderer.on('config:changed', handler)
    return () => ipcRenderer.removeListener('config:changed', handler)
  },
  getLaunchAtLogin: () => ipcRenderer.invoke('app:launchAtLogin:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:launchAtLogin:set', enabled),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  getRuntimeState: () => ipcRenderer.invoke('runtime:state'),
  installPackage: () => ipcRenderer.invoke('runtime:install'),
  uninstallPackage: () => ipcRenderer.invoke('runtime:uninstall'),
  restartTerminal: () => ipcRenderer.invoke('runtime:restart'),
  copyTerminalCredentials: () => ipcRenderer.invoke('runtime:copyCredentials'),
  onRuntimeState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RuntimeState): void =>
      callback(state)
    ipcRenderer.on('runtime:state', handler)
    return () => ipcRenderer.removeListener('runtime:state', handler)
  },
  listConnections: () => ipcRenderer.invoke('connections:list'),
  addConnection: (input) => ipcRenderer.invoke('connections:add', input),
  selectDirectory: () => ipcRenderer.invoke('dialog:directory'),
  updateConnection: (id, input) => ipcRenderer.invoke('connections:update', id, input),
  selectConnection: (id) => ipcRenderer.invoke('connections:select', id),
  reloadConnection: () => ipcRenderer.invoke('connections:reload'),
  removeConnection: (id) => ipcRenderer.invoke('connections:remove', id),
  onConnectionState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state): void => callback(state)
    ipcRenderer.on('connections:state', handler)
    return () => ipcRenderer.removeListener('connections:state', handler)
  },
  resetApp: () => ipcRenderer.invoke('app:reset'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
