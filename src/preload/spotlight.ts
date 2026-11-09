import { contextBridge, ipcRenderer } from 'electron'
import type { SpotlightAPI, SpotlightInit } from '../shared/spotlight'

// The first init can arrive while the renderer is still loading translations.
let latestInit: SpotlightInit | undefined
ipcRenderer.on('spotlight:init', (_event, state: SpotlightInit) => {
  latestInit = state
})

const api: SpotlightAPI = {
  onInit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SpotlightInit): void =>
      callback(state)
    ipcRenderer.on('spotlight:init', listener)
    if (latestInit) callback(latestInit)
    return () => ipcRenderer.removeListener('spotlight:init', listener)
  },
  onHide: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('spotlight:hide', listener)
    return () => ipcRenderer.removeListener('spotlight:hide', listener)
  },
  close: () => ipcRenderer.invoke('spotlight:close'),
  addConnection: () => ipcRenderer.invoke('spotlight:addConnection'),
  sendEvent: (connection, event) => ipcRenderer.invoke('spotlight:event', connection, event),
  capture: (rect) => ipcRenderer.invoke('spotlight:capture', rect),
  savePosition: (position) => ipcRenderer.invoke('spotlight:position', position)
}

contextBridge.exposeInMainWorld('spotlight', api)
