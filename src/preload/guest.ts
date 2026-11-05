import { contextBridge, ipcRenderer } from 'electron'
import { belongsToConnection, type TetherBridge } from '../shared/connections'
import { installGeolocationTimeout } from './geolocation'

let managed = false

const bridge: TetherBridge = {
  version: 1,
  isFocused: () => ipcRenderer.invoke('tether:isFocused'),
  focus: () => ipcRenderer.invoke('tether:focus'),
  onEvent: (callback) => {
    const listener = async (
      _event: Electron.IpcRendererEvent,
      id: string | null,
      event
    ): Promise<void> => {
      let error = ''
      try {
        await callback(event)
      } catch (cause) {
        error = String(cause).slice(0, 500)
      }
      if (id) await ipcRenderer.invoke('tether:event:ack', id, error).catch(() => {})
    }
    ipcRenderer.on('tether:event', listener)
    void ipcRenderer.invoke('tether:event:ready', true).catch(() => {})
    return () => {
      ipcRenderer.removeListener('tether:event', listener)
      void ipcRenderer.invoke('tether:event:ready', false).catch(() => {})
    }
  },
  signedIn: (token) => {
    managed = true
    return ipcRenderer.invoke('tether:login', token)
  },
  refresh: (force) => {
    managed = true
    return ipcRenderer.invoke('tether:refresh', force)
  },
  signedOut: () => ipcRenderer.invoke('tether:logout'),
  onToken: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, access): void => callback(access)
    ipcRenderer.on('tether:token', listener)
    return () => ipcRenderer.removeListener('tether:token', listener)
  }
}

const connectionURL = process.argv
  .find((argument) => argument.startsWith('--tether-connection-url='))
  ?.slice('--tether-connection-url='.length)

if (process.isMainFrame && connectionURL && belongsToConnection(location.href, connectionURL)) {
  contextBridge.executeInMainWorld({ func: installGeolocationTimeout })
  contextBridge.exposeInMainWorld('tether', bridge)
  // Reuse WebUI's existing theme notification hook, including changes between equal palettes.
  let lastTheme = ''
  const syncTheme = (): void => {
    const theme = localStorage.getItem('theme') ?? 'system'
    if (theme === lastTheme) return
    lastTheme = theme
    void ipcRenderer.invoke('tether:theme', theme).catch(() => {})
  }
  const scheduleTheme = (): void => queueMicrotask(syncTheme)
  contextBridge.exposeInMainWorld('applyTheme', scheduleTheme)
  window.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(scheduleTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    window.addEventListener('storage', scheduleTheme)
    syncTheme()
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
  })
  // Old WebUI versions have no bridge hooks. Observe their existing token lifecycle.
  let previous: string | null = null
  let working = false
  window.addEventListener('DOMContentLoaded', () => {
    const timer = setInterval(async () => {
      if (working || managed) return
      const token = localStorage.getItem('token')
      if (token === previous) return
      const old = previous
      previous = token
      working = true
      try {
        if (token) await ipcRenderer.invoke('tether:login', token)
        else if (old) await bridge.signedOut()
      } catch {
        // WebUI owns displaying authentication failures; never log credentials.
      } finally {
        working = false
      }
    }, 2000)
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  })
}
