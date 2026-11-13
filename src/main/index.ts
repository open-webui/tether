import { t, setLanguage } from './i18n'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray
} from 'electron'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import log from 'electron-log'
import icon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/tray.png?asset'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  initUpdater,
  installUpdate,
  setAutomaticUpdates
} from './updater'
import type { AppInfo } from '../shared/api'
import { parseGeneralConfig, parseLocalServerConfig, type AppConfig } from '../shared/config'
import { sandboxConfigChanged } from '../shared/sandbox'
import { getSandboxSupport, sandboxForbiddenPaths } from './sandbox'
import { validateWorkspace } from './sandbox/policy'

import { Connections } from './connections'
import { Spotlight } from './spotlight'
import { setTooltip } from './tooltip'
import { attachContextMenu } from './contextMenu'

// Keep Electron's storage and encryption identity stable across display-name changes.
app.setName('Tether')
const connections = new Connections((theme) => saveConfig({ theme }, false))
if (app.isPackaged) log.transports.console.level = false
log.initialize()
log.errorHandler.startCatching()

// Retry Linux's default graphics after an Electron upgrade, as Desktop does.
const gpuCrashMarkerPath = join(
  app.getPath('userData'),
  process.platform === 'linux'
    ? `.gpu-sandbox-disabled-${process.versions.electron}`
    : '.gpu-sandbox-disabled'
)
const gpuSandboxDisabled =
  existsSync(gpuCrashMarkerPath) || app.commandLine.hasSwitch('disable-gpu-sandbox')

if (gpuSandboxDisabled) {
  log.info('Applying saved GPU crash workaround')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  if (process.platform === 'linux' && !app.commandLine.hasSwitch('use-angle')) {
    app.commandLine.appendSwitch('use-gl', 'angle')
    app.commandLine.appendSwitch('use-angle', 'swiftshader')
  }
}
app.disableDomainBlockingFor3DAPIs()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let shutdownStarted = false
let resetting = false
const registeredShortcuts = { globalShortcut: '', spotlightShortcut: '' }
const shortcutKeys = ['globalShortcut', 'spotlightShortcut'] as const
const spotlight = new Spotlight(connections, showMainWindow, () => mainWindow?.hide())
const openSpotlight = (): void => {
  void spotlight.toggle().catch((error) => log.warn('Could not open Spotlight:', error))
}
let savingConfig: Promise<void> = Promise.resolve()
let saveWindowState: () => Promise<void> = () => Promise.resolve()

function showMainWindow(): void {
  if (!mainWindow) createMainWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.webContents.send('window:visibility', true)
  mainWindow?.focus()
}

function openExternal(url: string): void {
  if (!['https:', 'http:'].includes(new URL(url).protocol)) return
  void shell.openExternal(url).catch((error) => log.warn('Could not open link:', error))
}

function createMainWindow(show = true): void {
  const saved = connections.store.general.windowBounds
  const options: Electron.BrowserWindowConstructorOptions = {
    title: 'Open WebUI Tether',
    width: saved?.width ?? 960,
    height: saved?.height ?? 680,
    minWidth: 480,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f5f5f7',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            height: 32,
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000'
          }
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      zoomFactor: connections.store.general.uiScale,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: true
    }
  }
  // Desktop's visible-overlap check avoids restoring onto a disconnected monitor.
  if (
    saved &&
    screen
      .getAllDisplays()
      .some(
        ({ workArea }) =>
          Math.min(saved.x + saved.width, workArea.x + workArea.width) -
            Math.max(saved.x, workArea.x) >=
            100 &&
          Math.min(saved.y + saved.height, workArea.y + workArea.height) -
            Math.max(saved.y, workArea.y) >=
            100
      )
  ) {
    options.x = saved.x
    options.y = saved.y
  }
  const window = new BrowserWindow(options)
  mainWindow = window
  let normalBounds = window.getBounds()
  let maximized = connections.store.general.windowMaximized
  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  saveWindowState = () => {
    clearTimeout(boundsTimer)
    if (resetting || window.isDestroyed()) return Promise.resolve()
    if (!window.isFullScreen()) normalBounds = window.getNormalBounds()
    return saveConfig({ windowBounds: normalBounds, windowMaximized: maximized })
  }
  const boundsChanged = (): void => {
    if (!window.isVisible() || window.isMinimized() || window.isFullScreen()) return
    maximized = window.isMaximized()
    if (!maximized) normalBounds = window.getNormalBounds()
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      void saveWindowState().catch((error) => log.warn('Could not save window state:', error))
    }, 500)
  }
  window.on('resize', boundsChanged)
  window.on('move', boundsChanged)
  window.on('maximize', boundsChanged)
  window.on('unmaximize', boundsChanged)
  window.on('leave-full-screen', boundsChanged)
  window.on('closed', () => clearTimeout(boundsTimer))
  // Maximizing shows the window, so defer it when starting in the background.
  if (maximized) window.once('show', () => window.maximize())
  const visibilityChanged = (): void => {
    // Native visibility can settle after the event, and macOS also emits hide on occlusion.
    setImmediate(() => {
      if (!window.isDestroyed())
        window.webContents.send('window:visibility', window.isVisible() && !window.isMinimized())
    })
  }
  window.on('show', visibilityChanged)
  window.on('hide', visibilityChanged)
  window.on('minimize', visibilityChanged)
  window.on('restore', visibilityChanged)
  connections.attach(window)
  optimizer.watchWindowShortcuts(window)
  attachContextMenu(window.webContents)
  window.once('ready-to-show', () => {
    if (show) window.show()
  })
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      if (connections.store.general.runInBackground) {
        window.hide()
        visibilityChanged()
      } else app.quit()
    }
  })
  const updateTheme = (): void => {
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f5f5f7')
    if (process.platform !== 'darwin')
      window.setTitleBarOverlay({
        symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000'
      })
  }
  nativeTheme.on('updated', updateTheme)
  window.on('closed', () => {
    nativeTheme.removeListener('updated', updateTheme)
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternal(url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer exited:', details)
    if (details.reason !== 'clean-exit' && !quitting) window.webContents.reload()
  })

  const loading =
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
      : window.loadFile(join(__dirname, '../renderer/index.html'))
  void loading.catch((error) => log.error('Could not load Tether:', error))
}

function saveConfig(value: unknown, syncTheme = true): Promise<void> {
  const operation = savingConfig.then(async () => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid settings')
    const patch = value as Partial<AppConfig>
    const store = connections.store
    const previous = store.general
    const previousServer = store.localServer
    const next = parseGeneralConfig({ ...previous, ...patch })
    const localServer =
      'localServer' in patch ? parseLocalServerConfig(patch.localServer) : previousServer
    if (localServer.enabled !== previousServer.enabled)
      throw new Error('Install Open Terminal from Settings to enable it.')
    const sandboxChanged = sandboxConfigChanged(previousServer.sandbox, localServer.sandbox)
    if (sandboxChanged && localServer.sandbox.enabled) {
      const support = await getSandboxSupport()
      if (!support.supported)
        throw new Error(support.reason || 'Sandboxing is unavailable on this device.')
      localServer.sandbox.workspacePath = await validateWorkspace(
        localServer.sandbox.workspacePath,
        sandboxForbiddenPaths(),
        AbortSignal.timeout(30000)
      )
    }
    if (localServer.homeDirectory && localServer.homeDirectory !== previousServer.homeDirectory) {
      if (!isAbsolute(localServer.homeDirectory))
        throw new Error('Enter an absolute home directory path.')
      const directory = await stat(localServer.homeDirectory).catch(() => null)
      if (!directory?.isDirectory())
        throw new Error('Choose an existing folder for the home directory.')
    }
    const changed = shortcutKeys.filter(
      (key) =>
        next[key] !== previous[key] || (key in patch && next[key] !== registeredShortcuts[key])
    )
    const reserved: string[] = []
    try {
      for (const key of changed) {
        if (next[key]) {
          registerShortcut(next[key], key === 'globalShortcut' ? showMainWindow : openSpotlight)
          reserved.push(next[key])
        }
      }
      const save = async (): Promise<void> => {
        store.general = next
        store.localServer = localServer
        await store.saveConfig()
      }
      if (sandboxChanged) await connections.applySandboxConfig(save)
      else await save()
    } catch (error) {
      store.general = previous
      store.localServer = previousServer
      for (const accelerator of reserved) globalShortcut.unregister(accelerator)
      throw error
    }
    for (const key of changed) {
      if (registeredShortcuts[key]) globalShortcut.unregister(registeredShortcuts[key])
      registeredShortcuts[key] = next[key]
    }
    if (next.language !== previous.language) {
      await setLanguage(next.language || app.getLocale())
      createMenus()
    }
    nativeTheme.themeSource = next.theme
    if ('uiScale' in patch) connections.syncUIScale()
    if (next.automaticUpdates !== previous.automaticUpdates)
      setAutomaticUpdates(next.automaticUpdates)
    mainWindow?.webContents.send('config:changed', {
      ...store.general,
      localServer: store.localServer
    })
    if (syncTheme && 'theme' in patch) connections.syncTheme(next.theme)
    updateTray()
    if (next.deviceName !== previous.deviceName) connections.updateDeviceName()
    if (
      !sandboxChanged &&
      !localServer.sandbox.enabled &&
      (localServer.httpEnabled !== previousServer.httpEnabled ||
        (localServer.httpEnabled && localServer.httpHost !== previousServer.httpHost))
    )
      await connections.applyTerminalTransport()
  })
  savingConfig = operation.catch(() => {})
  return operation
}

function registerIPC(): void {
  const handle = (channel: string, callback: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error('Unknown IPC sender')
      }
      if (quitting) throw new Error('Tether is shutting down.')
      return callback(...args)
    })
  }
  handle('app:reset', async () => {
    if (resetting || !mainWindow) return
    resetting = true
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: t('dialogs.resetConfirm'),
        detail: t('dialogs.resetDetails'),
        buttons: [t('common.cancel'), t('common.reset')],
        defaultId: 0,
        cancelId: 0
      })
      if (response !== 1 || quitting) return
      quitting = true
      await savingConfig
      if (process.platform !== 'linux') app.setLoginItemSettings({ openAtLogin: false })
      await connections.reset()
      await mainWindow.webContents.session.clearStorageData()
      await mainWindow.webContents.session.clearCache()
      app.relaunch()
      app.quit()
    } catch (error) {
      quitting = false
      log.error('Factory reset failed:', error)
      throw new Error('Factory reset failed. Quit and reopen Tether to try again. ' + String(error))
    } finally {
      resetting = false
    }
  })
  handle('spotlight:open', () => spotlight.toggle())
  handle('window:tooltip', (value) => setTooltip(mainWindow, value))
  handle('window:visibility', () => !!mainWindow?.isVisible() && !mainWindow.isMinimized())
  handle(
    'app:info',
    (): AppInfo => ({
      deviceName: connections.store.deviceName,
      homeDirectory: homedir(),
      name: 'Open WebUI Tether',
      version: app.getVersion(),
      platform: process.platform
    })
  )
  handle(
    'config:get',
    (): AppConfig => ({ ...connections.store.general, localServer: connections.store.localServer })
  )
  handle('dialog:directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      defaultPath: connections.store.localServer.homeDirectory || homedir()
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('config:set', (value) => saveConfig(value))
  handle(
    'app:launchAtLogin:get',
    () => process.platform !== 'linux' && app.getLoginItemSettings().openAtLogin
  )
  handle('app:launchAtLogin:set', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid launch at login setting')
    if (process.platform === 'linux')
      throw new Error('Launch at login is not supported on this platform.')
    app.setLoginItemSettings({ openAtLogin: enabled })
    const actual = app.getLoginItemSettings().openAtLogin
    if (actual !== enabled)
      throw new Error('Could not change launch at login. Check your system settings.')
    return actual
  })
  handle('update:state', getUpdateState)
  handle('update:check', checkForUpdates)
  handle('update:download', downloadUpdate)
  handle('update:install', installUpdate)
}

function createMenus(): void {
  app.setAboutPanelOptions({
    applicationName: 'Open WebUI Tether',
    applicationVersion: app.getVersion(),
    copyright: t('settings.about.copyright', { year: new Date().getFullYear() }),
    website: 'https://github.com/open-webui/tether',
    iconPath: icon
  })
  const checkUpdates = (): void => {
    showMainWindow()
    void checkForUpdates()
  }
  const updateItem = { label: t('settings.about.checkUpdates'), click: checkUpdates }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Open WebUI Tether',
      submenu: [
        { label: t('settings.about.title'), click: () => app.showAboutPanel() },
        updateItem,
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? ([
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: t('menu.hide') },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' }
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        { role: 'quit', label: t('menu.quit') }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: t('menu.window'),
      submenu: [
        { label: t('menu.show'), click: showMainWindow },
        { label: t('settings.general.openSpotlight'), click: openSpotlight },
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: t('menu.github'),
          click: () => openExternal('https://github.com/open-webui/tether')
        },
        {
          label: t('menu.logs'),
          click: () => {
            void shell.openPath(app.getPath('logs'))
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  updateTray()
}

function createTrayImage(): Electron.NativeImage {
  if (process.platform !== 'darwin') {
    return nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  }
  const image = nativeImage.createFromPath(trayIcon)
  image.setTemplateImage(true)
  return image
}

function updateTray(): void {
  if (process.platform === 'darwin' && !connections.store.general.showMenuBarIcon) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(createTrayImage())
    tray.setToolTip('Open WebUI Tether')
    tray.on('click', showMainWindow)
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('menu.show'), click: showMainWindow },
      { label: t('settings.general.openSpotlight'), click: openSpotlight },
      {
        label: t('settings.about.checkUpdates'),
        click: () => {
          showMainWindow()
          void checkForUpdates()
        }
      },
      { type: 'separator' },
      { label: t('menu.quit'), click: () => app.quit() }
    ])
  )
}

function registerShortcut(accelerator: string, callback: () => void): void {
  try {
    if (globalShortcut.register(accelerator, callback)) return
  } catch {
    /* Report invalid accelerators and registration conflicts consistently. */
  }
  throw new Error(
    `Could not register shortcut "${accelerator}". It may be invalid or used by another application.`
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return
    log.error('GPU process exited:', details)
    if (
      gpuSandboxDisabled ||
      quitting ||
      !['crashed', 'launch-failed', 'abnormal-exit'].includes(details.reason)
    )
      return
    quitting = true
    try {
      writeFileSync(gpuCrashMarkerPath, new Date().toISOString(), 'utf8')
    } catch (error) {
      log.warn('Could not save GPU crash workaround:', error)
    }
    app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu-sandbox'] })
    // Use Tether's shutdown path so local runtimes and terminals stop before relaunching.
    app.quit()
  })
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
  })
  app.on('activate', () => {
    if (app.isReady()) showMainWindow()
  })
  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    event.preventDefault()
    shutdownStarted = true
    quitting = true
    spotlight.destroy()
    void saveWindowState()
      .catch((error) => log.warn('Could not save window state:', error))
      .then(() => connections.stop())
      .finally(() => app.quit())
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  })
  app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('com.openwebui.tether')
      app.dock?.setIcon(icon)
      await connections.initialize()
      // A socket that slept through a network change looks open until the heartbeat notices.
      powerMonitor.on('resume', () => connections.probeRelays())
      powerMonitor.on('unlock-screen', () => connections.probeRelays())
      nativeTheme.themeSource = connections.store.general.theme
      spotlight.initialize()
      for (const key of shortcutKeys) {
        const accelerator = connections.store.general[key]
        if (!accelerator) continue
        try {
          registerShortcut(accelerator, key === 'globalShortcut' ? showMainWindow : openSpotlight)
          registeredShortcuts[key] = accelerator
        } catch (error) {
          log.warn(error)
          if (Notification.isSupported())
            new Notification({
              title: t('menu.shortcut'),
              body: String(error).replace(/^Error: /, '')
            }).show()
        }
      }
      registerIPC()
      createMenus()
      createMainWindow(!connections.store.general.startMinimized)
      initUpdater(
        (channel, state) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, state)
        },
        connections.store.general.automaticUpdates,
        () => {
          quitting = true
        }
      )
      log.info('Tether started', { version: app.getVersion(), platform: process.platform })
    })
    .catch((error) => {
      log.error('Could not start Tether:', error)
      app.exit(1)
    })
}
