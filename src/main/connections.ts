import { t, setLanguage } from './i18n'
import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Notification,
  shell,
  WebContentsView,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  belongsToConnection,
  connectionRedirectError,
  endpoint,
  normalizeURL,
  type AccessToken,
  type Connection,
  type ConnectionState
} from '../shared/connections'
import { homedir } from 'node:os'
import type { TerminalTarget } from '../shared/terminal'
import { ManagedService } from './process/managedService'
import { spawnPty } from './process/nativePty'
import { attachTerminal } from './process/terminalChannel'
import { Sessions } from './sessions'
import { connectionSession, validateConnection } from './network'
import { accessCookies, accessHeaders, isAccessLogin } from './access'
import { OpenTerminal, type TerminalHandle } from './terminal'
import { Relay } from './relay'
import { Store } from './store'
import type { GeneralConfig, RuntimeState } from '../shared/config'
import { attachContextMenu } from './contextMenu'
import { validateEvent, type TetherEvent } from '../shared/events'

interface LocalConnection {
  relay?: Relay
  handle?: TerminalHandle
  retry?: ReturnType<typeof setTimeout>
  starting?: boolean
  relayError?: string
  terminalError?: string
}

export class Connections {
  readonly store = new Store()
  readonly sessions = new Sessions(
    this.store,
    (id, token) => this.tokenChanged(id, token),
    (id, message) => this.fail(id, message)
  )
  private terminal = new OpenTerminal(
    () => this.store.localServer,
    (state) => this.runtimeChanged(state)
  )
  private updatingRuntime = false
  private local = new Map<string | null, LocalConnection>()
  private terminalHeight = 0
  private localShell = new ManagedService(spawnPty, true)
  private settingsOpen = false
  private notificationIds = new Set<string>()
  private notifications = new Map<string, Electron.Notification>()
  private stopped = false
  private views = new Map<string, WebContentsView>()
  private titles = new Map<string, string>()
  private errors: Record<string, string> = {}
  private window?: BrowserWindow
  private eventReady = new Set<string>()
  private pendingEvent?: {
    id: string
    connection: Connection
    userId: string
    payload: TetherEvent
    sent: boolean
    finish: (error?: string) => void
  }

  private themes = new Map<string, GeneralConfig['theme']>()
  private pendingThemes = new Map<string, GeneralConfig['theme']>()

  constructor(private themeChanged: (theme: GeneralConfig['theme']) => Promise<void>) {}

  syncTheme(theme: GeneralConfig['theme']): void {
    for (const id of this.views.keys()) {
      this.themes.set(id, theme)
      this.pendingThemes.set(id, theme)
      this.deliverTheme(id)
    }
  }

  private deliverTheme(id: string): void {
    const theme = this.pendingThemes.get(id)
    const connection = this.store.connections.find((item) => item.id === id)
    const view = this.views.get(id)
    if (
      theme &&
      connection &&
      view &&
      this.eventReady.has(id) &&
      belongsToConnection(view.webContents.getURL(), connection.url)
    ) {
      view.webContents.send('tether:event', null, { type: 'theme:update', data: { theme } })
    }
  }

  async showConnection(id: string | null, path?: string): Promise<void> {
    this.settingsOpen = false
    this.window?.webContents.send('connections:show')
    await this.select(id, path)
  }

  async sendEvent(connection: Connection, payload: TetherEvent): Promise<void> {
    validateEvent(payload)
    const saved = this.store.connections.find((item) => item.id === connection?.id)
    if (!saved || saved.url !== connection.url)
      throw new Error('This connection changed. Select a saved connection and try again.')
    if (this.pendingEvent) throw new Error('A handoff is already in progress.')
    await this.showConnection(saved.id)
    const userId = this.store.credentials[saved.id]?.userId
    if (!userId)
      throw new Error(
        'Sign in to this WebUI, then reopen Spotlight and send again. Your draft is kept.'
      )
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEvent?.finish(
          'WebUI did not confirm the handoff. Check the chat before retrying. Update WebUI if it does not support Spotlight.'
        )
      }, 30_000)
      this.pendingEvent = {
        id: randomUUID(),
        connection: { ...saved },
        userId,
        payload,
        sent: false,
        finish: (error) => {
          clearTimeout(timer)
          this.pendingEvent = undefined
          if (error) reject(new Error(error))
          else resolve()
        }
      }
      this.deliverEvent()
    })
  }

  private deliverEvent(): void {
    const pending = this.pendingEvent
    if (!pending || pending.sent || !this.eventReady.has(pending.connection.id)) return
    const { id, connection, payload } = pending
    const view = this.views.get(connection.id)
    if (this.store.credentials[connection.id]?.userId !== pending.userId) {
      pending.finish('The signed-in account changed. Review the destination and send again.')
    } else if (view && belongsToConnection(view.webContents.getURL(), connection.url)) {
      pending.sent = true
      view.webContents.send('tether:event', id, payload)
    }
  }

  async initialize(): Promise<void> {
    await this.store.load()
    await setLanguage(this.store.general.language || app.getLocale())
    void this.startLocalTerminal()
    this.sessions.start()
    for (const id of Object.keys(this.store.credentials)) void this.ensureLocal(id)
  }

  attach(window: BrowserWindow): void {
    this.window = window
    window.on('resize', () => this.layout())
    window.webContents.on('did-start-loading', () => {
      this.settingsOpen = false
      this.terminalHeight = 0
      this.layout()
    })
    this.registerIPC()
    if (this.store.selected)
      void this.select(this.store.selected).catch((error) =>
        this.fail(this.store.selected!, String(error))
      )
  }

  private state(): ConnectionState {
    const selected = this.store.connections.find((item) => item.id === this.store.selected)
    const local = selected && this.local.get(selected.id)
    return {
      connections: this.store.connections,
      selected: this.store.selected,
      terminalStatus: this.terminal.getStatus(this.store.selected),
      webuiConnected: Boolean(
        local?.relay?.connected && local.handle?.service.info.status === 'started'
      ),
      title: this.settingsOpen
        ? t('settings.title')
        : (selected && this.titles.get(selected.id)) || selected?.name || 'Open WebUI Tether',
      errors: this.errors,
      persistentCredentials: this.store.persistentCredentials
    }
  }

  private emit(): void {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('connections:state', this.state())
  }

  private fail(id: string, message: string): void {
    this.errors[id] = message
    this.emit()
  }

  private tokenChanged(id: string, access: AccessToken | null): void {
    if (
      this.pendingEvent?.connection.id === id &&
      (!access || this.store.credentials[id]?.userId !== this.pendingEvent.userId)
    )
      this.pendingEvent.finish(
        'The signed-in account changed. Review the destination and send again.'
      )
    delete this.errors[id]
    if (access) {
      this.local.get(id)?.relay?.updateToken(access.token)
      void this.ensureLocal(id)
    } else {
      for (const [key, notification] of this.notifications) {
        if (key.startsWith(id + ':')) {
          notification.close()
          this.notifications.delete(key)
        }
      }
      const local = this.local.get(id)
      this.local.delete(id)
      clearTimeout(local?.retry)
      local?.relay?.stop()
      void local?.handle?.stop()
    }
    const view = this.views.get(id)
    const connection = this.store.connections.find((item) => item.id === id)
    if (view && connection && belongsToConnection(view.webContents.getURL(), connection.url)) {
      view.webContents.send('tether:token', access)
    }
    this.emit()
  }

  private shellSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): void {
    if (this.stopped) throw new Error('Tether is shutting down.')
    if (event.sender !== this.window?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unknown IPC sender')
    }
  }

  private guestSender(event: IpcMainInvokeEvent): string {
    if (this.stopped) throw new Error('Tether is shutting down.')
    for (const [id, view] of this.views) {
      const connection = this.store.connections.find((item) => item.id === id)
      if (
        event.sender === view.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        connection &&
        belongsToConnection(event.senderFrame.url, connection.url)
      )
        return id
    }
    throw new Error('Unknown WebUI sender')
  }

  private runtimeChanged(state: RuntimeState): void {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('runtime:state', state)
    this.emit()
  }

  private async restartTerminal(update = false): Promise<void> {
    if (this.updatingRuntime) throw new Error('Open Terminal is already restarting or updating.')
    this.updatingRuntime = true
    let installed = false
    const entries = [...this.local.values()]
    for (const entry of entries) {
      if (!entry.relay && !entry.handle) continue
      clearTimeout(entry.retry)
      entry.retry = undefined
      entry.handle = undefined
      entry.relay?.setService('open_terminal')
    }
    try {
      if (update) {
        if (this.stopped) return
        await this.terminal.installPackage()
      } else {
        await this.terminal.restart()
      }
      installed = true
    } finally {
      this.updatingRuntime = false
      if (installed && !this.stopped) {
        void this.startLocalTerminal()
        for (const [id, entry] of this.local) void this.startTerminal(id, entry)
      }
    }
  }

  async applyTerminalTransport(): Promise<void> {
    // An install/uninstall already owns relaunching. Still close any old listener now.
    if (this.updatingRuntime) await this.terminal.restart()
    else await this.restartTerminal()
  }

  private registerIPC(): void {
    ipcMain.handle('terminal:height', (event, height: number) => {
      this.shellSender(event)
      if (!Number.isFinite(height) || height < 0) throw new Error('Invalid terminal height')
      this.terminalHeight = Math.min(height, 1000)
      this.layout()
    })
    ipcMain.on('terminal:connect', (event, target: TerminalTarget, attachment: number) => {
      try {
        this.shellSender(event)
        if (
          !Number.isSafeInteger(attachment) ||
          attachment < 1 ||
          !target ||
          typeof target !== 'object'
        )
          return
        let service: ManagedService
        if (target.type === 'shell') {
          service = this.localShell
          if (service.info.status === 'stopped' || service.info.status === 'failed') {
            const env = Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string' &&
                  !/^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(entry[0])
              )
            )
            void service
              .start(async () => ({
                file:
                  process.platform === 'win32'
                    ? process.env.COMSPEC || 'cmd.exe'
                    : process.env.SHELL || '/bin/sh',
                args: process.platform === 'win32' ? [] : ['-l'],
                cwd: homedir(),
                env
              }))
              .catch(() => {
                /* ManagedService reports the failure in its output. */
              })
          }
        } else if (
          target.type === 'service' &&
          (target.id === null || this.store.connections.some((item) => item.id === target.id))
        ) {
          service = this.terminal.getService(target.id)
          if (service.info.status === 'stopped') service = this.terminal.getService(null)
        } else return
        attachTerminal(service, event.sender, attachment)
      } catch {
        /* Reject requests from embedded or unknown renderers. */
      }
    })
    ipcMain.handle('settings:open', (event, open: boolean) => {
      this.shellSender(event)
      if (typeof open !== 'boolean') throw new Error('Invalid settings state')
      this.settingsOpen = open
      this.layout()
      this.emit()
    })
    ipcMain.handle('runtime:state', (event) => {
      this.shellSender(event)
      return this.terminal.getState()
    })
    ipcMain.handle('runtime:restart', (event) => {
      this.shellSender(event)
      return this.restartTerminal()
    })
    ipcMain.handle('runtime:copyCredentials', (event) => {
      this.shellSender(event)
      clipboard.writeText(JSON.stringify(this.terminal.credentials(this.store.selected), null, 2))
    })
    ipcMain.handle('runtime:install', (event) => {
      this.shellSender(event)
      return this.confirmInstall()
    })
    ipcMain.handle('runtime:uninstall', (event) => {
      this.shellSender(event)
      return this.uninstallTerminal()
    })
    ipcMain.handle('connections:list', (event) => {
      this.shellSender(event)
      return this.state()
    })
    ipcMain.handle(
      'connections:add',
      async (event, input: { name: string; url: string; installTerminal?: boolean }) => {
        this.shellSender(event)
        if (
          !input ||
          typeof input.url !== 'string' ||
          typeof input.name !== 'string' ||
          input.name.length > 100 ||
          (input.installTerminal !== undefined && typeof input.installTerminal !== 'boolean')
        ) {
          throw new Error('Invalid connection')
        }
        const connection = await validateConnection({
          id: randomUUID(),
          name: input.name.trim() || new URL(input.url.trim()).host,
          url: input.url
        })
        this.store.connections.push(connection)
        await this.store.saveConfig()
        await this.select(connection.id)
        if (input.installTerminal) {
          void this.installTerminal().catch((error) => {
            if (this.store.connections.some((item) => item.id === connection.id))
              this.fail(connection.id, String(error))
          })
        }
        return this.state()
      }
    )
    ipcMain.handle(
      'connections:update',
      async (event, id: string, input: { name: string; url: string }) => {
        this.shellSender(event)
        const connection = this.store.connections.find((item) => item.id === id)
        if (!connection) throw new Error('Unknown connection')
        if (
          !input ||
          typeof input.url !== 'string' ||
          typeof input.name !== 'string' ||
          input.name.length > 100
        )
          throw new Error('Invalid connection')
        const url = normalizeURL(input.url.trim())
        const updated = await validateConnection({
          ...connection,
          url,
          trustedCertificate: url === connection.url ? connection.trustedCertificate : undefined
        })
        if (!this.store.connections.includes(connection)) throw new Error('Unknown connection')
        const previous = { ...connection }
        if (
          url !== connection.url ||
          updated.trustedCertificate !== connection.trustedCertificate
        ) {
          // Validation may have just signed in to Access in the profile we are clearing.
          const cookies = await accessCookies(
            connectionSession(updated),
            endpoint(url, 'api/config')
          )
          await this.clearConnection(id)
          for (const cookie of cookies)
            await connectionSession(updated).cookies.set({
              ...cookie,
              url: endpoint(url, 'api/config'),
              domain: cookie.hostOnly ? undefined : cookie.domain
            })
        }
        connection.name = input.name.trim() || new URL(url).host
        connection.url = url
        connection.trustedCertificate = updated.trustedCertificate
        try {
          await this.store.saveConfig()
        } catch (error) {
          Object.assign(connection, previous)
          throw error
        }
        if (this.store.selected === id && !this.views.has(id)) this.createView(connection)
        this.layout()
        this.emit()
        return this.state()
      }
    )
    ipcMain.handle('connections:select', async (event, id: string | null) => {
      this.shellSender(event)
      await this.select(id)
    })
    ipcMain.handle('connections:reload', (event) => {
      this.shellSender(event)
      if (this.store.selected) this.views.get(this.store.selected)?.webContents.reload()
    })
    ipcMain.handle('connections:remove', async (event, id: string) => {
      this.shellSender(event)
      if (!this.store.connections.some((item) => item.id === id))
        throw new Error('Unknown connection')
      await this.clearConnection(id)
      this.store.connections = this.store.connections.filter((item) => item.id !== id)
      if (this.store.selected === id) this.store.selected = this.store.connections[0]?.id ?? null
      await this.store.saveConfig()
      await this.select(this.store.selected)
    })
    ipcMain.handle('tether:isFocused', (event) => {
      const id = this.guestSender(event)
      return Boolean(
        id === this.store.selected &&
        !this.settingsOpen &&
        this.window?.isVisible() &&
        !this.window.isMinimized() &&
        this.window.isFocused()
      )
    })
    ipcMain.handle('tether:focus', async (event) => {
      const id = this.guestSender(event)
      await this.showConnection(id)
      this.guestSender(event)
      if (this.window?.isMinimized()) this.window.restore()
      this.window?.show()
      this.window?.focus()
      this.views.get(id)?.webContents.focus()
    })
    ipcMain.handle('tether:login', (event, token: string) =>
      this.sessions.signedIn(this.guestSender(event), token)
    )
    ipcMain.handle('tether:refresh', (event, force?: boolean) =>
      this.sessions.refresh(this.guestSender(event), force === true)
    )
    ipcMain.handle('tether:logout', (event) => this.sessions.signedOut(this.guestSender(event)))
    ipcMain.handle('tether:theme', async (event, value: unknown) => {
      const id = this.guestSender(event)
      if (
        typeof value !== 'string' ||
        !['system', 'light', 'dark', 'oled-dark', 'her'].includes(value)
      )
        throw new Error('Invalid theme')
      const theme = value === 'system' ? 'system' : value.includes('dark') ? 'dark' : 'light'
      const pending = this.pendingThemes.get(id)
      if (pending && theme !== pending) return
      this.pendingThemes.delete(id)
      this.themes.set(id, theme)
      if (id === this.store.selected && theme !== this.store.general.theme)
        await this.themeChanged(theme)
    })
    ipcMain.handle('tether:event:ready', (event, ready: boolean) => {
      const id = this.guestSender(event)
      if (ready === true) this.eventReady.add(id)
      else this.eventReady.delete(id)
      this.deliverTheme(id)
      this.deliverEvent()
    })
    ipcMain.handle('tether:event:ack', (event, requestId: string, error: string) => {
      const id = this.guestSender(event)
      const pending = this.pendingEvent
      if (pending?.connection.id !== id || pending.id !== requestId || !pending.sent) return
      pending.finish(
        typeof error === 'string' ? error.slice(0, 500) : 'Invalid WebUI acknowledgement.'
      )
    })
  }

  private async clearConnection(id: string): Promise<void> {
    this.eventReady.delete(id)
    this.themes.delete(id)
    this.pendingThemes.delete(id)
    if (this.pendingEvent?.connection.id === id)
      this.pendingEvent.finish('This connection changed. Select a saved connection and try again.')
    const view = this.views.get(id)
    const profile =
      view?.webContents.session ??
      connectionSession(this.store.connections.find((item) => item.id === id)!)
    if (view) {
      this.views.delete(id)
      this.window?.contentView.removeChildView(view)
      view.webContents.close()
    }
    // Revoke against the old address before changing the saved connection.
    await this.sessions.signedOut(id)
    await profile.closeAllConnections()
    await profile.clearStorageData()
    await profile.clearCache()
    await this.terminal.remove(id)
    delete this.errors[id]
    this.titles.delete(id)
  }

  private async select(id: string | null, path?: string): Promise<void> {
    if (id !== null && !this.store.connections.some((item) => item.id === id))
      throw new Error('Unknown connection')
    this.store.selected = id
    await this.store.saveConfig()
    if (id && !this.views.has(id))
      this.createView(this.store.connections.find((item) => item.id === id)!, path)
    else if (id && path) {
      const connection = this.store.connections.find((item) => item.id === id)!
      await this.views.get(id)!.webContents.loadURL(endpoint(connection.url, path))
    }
    const theme = id && this.themes.get(id)
    if (theme && theme !== this.store.general.theme) await this.themeChanged(theme)
    this.layout()
    this.emit()
  }

  private createView(connection: Connection, path?: string): void {
    const view = new WebContentsView({
      webPreferences: {
        session: connectionSession(connection),
        preload: join(__dirname, '../preload/guest.js'),
        additionalArguments: ['--tether-connection-url=' + connection.url],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.views.set(connection.id, view)
    // Keep the saved appearance until WebUI confirms it, including on older servers.
    this.pendingThemes.set(connection.id, this.store.general.theme)
    const canLocate = (
      requester: Electron.WebContents | null,
      details: { isMainFrame: boolean; requestingUrl?: string }
    ): boolean =>
      requester === view.webContents &&
      !view.webContents.isDestroyed() &&
      details.isMainFrame === true &&
      belongsToConnection(details.requestingUrl ?? '', connection.url) &&
      belongsToConnection(view.webContents.getURL(), connection.url)
    view.webContents.session.setPermissionCheckHandler(
      (requester, permission, requestingOrigin, details) => {
        if (permission !== 'geolocation' && permission !== 'geolocation-approximate') return true
        return (
          belongsToConnection(requestingOrigin, new URL(connection.url).origin) &&
          canLocate(requester, details)
        )
      }
    )
    view.webContents.session.setPermissionRequestHandler(
      (requester, permission, callback, details) => {
        // Keep other permissions unchanged; location belongs only to the saved WebUI page.
        callback(
          permission === 'geolocation' || permission === 'geolocation-approximate'
            ? canLocate(requester, details)
            : true
        )
      }
    )
    view.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        if (
          request.frame !== view.webContents.mainFrame ||
          !belongsToConnection(request.frame.url, connection.url)
        ) {
          callback(null)
          return
        }
        void desktopCapturer.getSources({ types: ['screen'] }).then(
          (sources) => {
            if (!request.frame) return
            callback(
              sources[0]
                ? { video: sources[0], ...(request.audioRequested ? { audio: 'loopback' } : {}) }
                : null
            )
          },
          () => {
            if (request.frame) callback(null)
          }
        )
      },
      { useSystemPicker: true }
    )
    attachContextMenu(view.webContents)
    view.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      this.eventReady.delete(connection.id)
      if (this.pendingEvent?.connection.id === connection.id && this.pendingEvent.sent)
        this.pendingEvent.finish(
          'WebUI navigated before confirming. Check the chat before retrying.'
        )
    })
    this.window!.contentView.addChildView(view)
    view.webContents.on('page-title-updated', (_event, title, explicitSet) => {
      this.titles.set(connection.id, explicitSet ? title.trim() : '')
      if (this.store.selected === connection.id) this.emit()
    })
    let legacySignIn = false
    let accessSignIn = false
    let signingIn = false
    const oauthProvider = (address: string): string | undefined => {
      if (!belongsToConnection(address, connection.url)) return
      const root = new URL(endpoint(connection.url, 'oauth/')).pathname
      const path = new URL(address).pathname
      if (!path.startsWith(root)) return
      return /^([a-zA-Z0-9_-]+)\/login\/?$/.exec(path.slice(root.length))?.[1]
    }
    const signIn = async (address: string, provider: string): Promise<void> => {
      if (signingIn) return
      signingIn = true
      try {
        const handled = await this.sessions.signInWithBrowser(connection.id, provider)
        if (!handled && this.views.get(connection.id) === view && !view.webContents.isDestroyed()) {
          // Restart in the same session so legacy OAuth state and callback cookies stay together.
          legacySignIn = true
          await view.webContents.loadURL(address)
        }
      } catch (error) {
        legacySignIn = false
        if (this.views.get(connection.id) === view) this.fail(connection.id, String(error))
      } finally {
        signingIn = false
      }
    }
    view.webContents.on('did-navigate', (_event, address) => {
      if (belongsToConnection(address, connection.url) && !oauthProvider(address)) {
        legacySignIn = false
        accessSignIn = false
      }
    })
    const navigate = (
      event: Electron.Event,
      address: string,
      _isInPlace?: boolean,
      isMainFrame?: boolean,
      isRedirect = false
    ): void => {
      if (isMainFrame === false) return
      if (isAccessLogin(address, connection.url)) accessSignIn = true
      if (belongsToConnection(address, connection.url)) {
        const provider = oauthProvider(address)
        if (provider && !legacySignIn) {
          event.preventDefault()
          void signIn(address, provider)
        }
        return
      }
      if (accessSignIn && address.startsWith('https://')) return
      if (legacySignIn && /^https?:\/\//i.test(address)) return
      event.preventDefault()
      if (isRedirect) {
        this.fail(connection.id, connectionRedirectError)
        return
      }
      if (['https:', 'http:'].includes(new URL(address).protocol)) void shell.openExternal(address)
    }
    view.webContents.on('will-navigate', (event, address) => navigate(event, address))
    view.webContents.on('will-redirect', (event, address, isInPlace, isMainFrame) =>
      navigate(event, address, isInPlace, isMainFrame, true)
    )
    view.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
      if (isAccessLogin(url, connection.url)) accessSignIn = true
      const provider = oauthProvider(url)
      if (provider && !legacySignIn) {
        void signIn(url, provider)
        return { action: 'deny' }
      }
      if (
        (accessSignIn && (url.startsWith('https://') || url === 'about:blank')) ||
        (legacySignIn &&
          disposition === 'new-window' &&
          features &&
          (/^https?:\/\//i.test(url) || url === 'about:blank'))
      ) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              session: view.webContents.session,
              preload: undefined,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false
            }
          }
        }
      }
      if (belongsToConnection(url, connection.url)) void view.webContents.loadURL(url)
      else if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on('did-create-window', (popup) => {
      const close = (): void => popup.close()
      view.webContents.once('destroyed', close)
      popup.once('closed', () => view.webContents.removeListener('destroyed', close))
    })
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        this.fail(
          connection.id,
          code <= -200 && code > -300
            ? 'WebUI certificate is invalid or changed. Edit the connection to review it.'
            : description
        )
    })
    view.webContents.on('render-process-gone', () =>
      this.fail(connection.id, 'WebUI stopped. Select Reload from the View menu.')
    )
    void view.webContents
      .loadURL(path ? endpoint(connection.url, path) : connection.url)
      .catch(() => {
        if (!this.errors[connection.id]) this.fail(connection.id, 'Could not load WebUI.')
      })
  }

  private layout(): void {
    if (!this.window) return
    const [width, height] = this.window.getContentSize()
    const zoom = this.window.webContents.getZoomFactor()
    const titlebarHeight = Math.ceil((process.platform === 'darwin' ? 28 : 32) * zoom)
    for (const [id, view] of this.views) {
      view.setVisible(id === this.store.selected && !this.settingsOpen)
      view.setBounds({
        x: 0,
        y: titlebarHeight,
        width,
        height: Math.max(0, height - titlebarHeight - Math.ceil((24 + this.terminalHeight) * zoom))
      })
    }
  }

  private localChanged(id: string | null, entry: LocalConnection): void {
    if (this.local.get(id) !== entry || this.stopped) return
    const error = entry.relayError || entry.terminalError
    if (id !== null) {
      if (error) this.errors[id] = error
      else delete this.errors[id]
    }
    this.emit()
  }

  private async confirmInstall(): Promise<void> {
    if (!this.window || this.stopped || this.updatingRuntime) return
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: t('dialogs.installConfirm'),
      detail: t('dialogs.installDetails'),
      buttons: [t('common.cancel'), t('common.install')],
      defaultId: 0,
      cancelId: 0
    })
    if (response !== 1 || this.stopped) return
    await this.installTerminal()
  }

  private async installTerminal(): Promise<void> {
    if (this.stopped || this.updatingRuntime) return
    await this.restartTerminal(true)
    if (this.stopped) return
    if (!this.store.localServer.enabled) {
      this.store.localServer.enabled = true
      try {
        await this.store.saveConfig()
      } catch (error) {
        this.store.localServer.enabled = false
        throw error
      }
      this.window?.webContents.send('config:changed', {
        ...this.store.general,
        localServer: this.store.localServer
      })
    }
    await this.startLocalTerminal()
    for (const id of Object.keys(this.store.credentials)) void this.ensureLocal(id)
    for (const [id, entry] of this.local) void this.startTerminal(id, entry)
  }

  private async uninstallTerminal(): Promise<void> {
    if (!this.window || this.stopped || this.updatingRuntime) return
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: t('dialogs.uninstallConfirm'),
      detail: t('dialogs.uninstallDetails'),
      buttons: [t('common.cancel'), t('common.uninstall')],
      defaultId: 0,
      cancelId: 0
    })
    if (response !== 1 || this.stopped || this.updatingRuntime) return
    this.updatingRuntime = true
    try {
      const enabled = this.store.localServer.enabled
      this.store.localServer.enabled = false
      try {
        await this.store.saveConfig()
      } catch (error) {
        this.store.localServer.enabled = enabled
        throw error
      }
      this.window.webContents.send('config:changed', {
        ...this.store.general,
        localServer: this.store.localServer
      })
      for (const [id, entry] of this.local) {
        clearTimeout(entry.retry)
        entry.retry = undefined
        entry.handle = undefined
        entry.relay?.setService('open_terminal')
        if (id !== null) {
          delete this.errors[id]
          if (!entry.relay) this.local.delete(id)
        }
      }
      this.local.delete(null)
      this.emit()
      await this.terminal.uninstallPackage()
      for (const id of Object.keys(this.store.credentials)) void this.ensureLocal(id)
    } finally {
      this.updatingRuntime = false
    }
  }

  updateDeviceName(): void {
    for (const entry of this.local.values()) entry.relay?.updateName()
  }

  private showNotification(id: string, value: unknown): void {
    if (!value || typeof value !== 'object' || this.stopped) return
    const payload = value as Record<string, unknown>
    if (
      typeof payload.id !== 'string' ||
      payload.id.length > 200 ||
      typeof payload.user_id !== 'string' ||
      typeof payload.title !== 'string' ||
      payload.title.length > 256 ||
      typeof payload.body !== 'string' ||
      payload.body.length > 4096 ||
      typeof payload.path !== 'string' ||
      payload.path.length > 1000 ||
      !/^\/(?:calendar|(?:c|channels)\/[^/?#]+)$/.test(payload.path)
    )
      return
    const connection = this.store.connections.find((item) => item.id === id)
    if (!connection || this.sessions.credential(id)?.userId !== payload.user_id) return
    const key = `${id}:${payload.user_id}:${payload.id}`
    if (this.notificationIds.has(key)) return
    this.notificationIds.add(key)
    if (this.notificationIds.size > 256)
      this.notificationIds.delete(this.notificationIds.values().next().value!)
    const view = this.views.get(id)
    const target = endpoint(connection.url, payload.path)
    if (
      id === this.store.selected &&
      !this.settingsOpen &&
      this.window?.isVisible() &&
      !this.window.isMinimized() &&
      this.window.isFocused() &&
      view?.webContents.getURL().split(/[?#]/)[0] === target &&
      payload.path !== '/calendar'
    )
      return
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: payload.title, body: payload.body })
    if (this.notifications.size >= 50) {
      const [oldest, previous] = this.notifications.entries().next().value!
      previous.close()
      this.notifications.delete(oldest)
    }
    this.notifications.set(key, notification)
    const dismiss = (): void => {
      this.notifications.delete(key)
    }
    notification.on('close', dismiss)
    notification.on('failed', dismiss)
    notification.on('click', () => {
      dismiss()
      if (
        this.stopped ||
        this.sessions.credential(id)?.userId !== payload.user_id ||
        !this.store.connections.some((item) => item.id === id && item.url === connection.url)
      )
        return
      void this.showConnection(id, payload.path as string)
        .then(() => {
          if (this.window?.isMinimized()) this.window.restore()
          this.window?.show()
          this.window?.focus()
          this.views.get(id)?.webContents.focus()
        })
        .catch(() => {})
    })
    notification.show()
  }

  private async ensureLocal(id: string): Promise<void> {
    if (this.stopped || this.local.has(id) || !this.sessions.credential(id)?.sessionId) return
    const connection = this.store.connections.find((item) => item.id === id)
    if (!connection) return
    const entry: LocalConnection = {}
    this.local.set(id, entry)
    try {
      const access = await this.sessions.refresh(id)
      if (!access) {
        if (this.local.get(id) === entry) this.local.delete(id)
        return
      }
      const response = await connectionSession(connection).fetch(
        endpoint(connection.url, 'api/config'),
        {
          headers: {
            ...(await accessHeaders(
              connectionSession(connection),
              endpoint(connection.url, 'api/config')
            )),
            Authorization: 'Bearer ' + access.token
          },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(15000)
        }
      )
      if (!response.ok) throw new Error('Could not reach WebUI.')
      const config = (await response.json()) as { features?: { tether?: boolean } }
      if (this.local.get(id) !== entry || this.stopped) return
      if (!config.features?.tether)
        throw new Error('This WebUI does not support Tether yet. Retrying.')
      entry.relay = new Relay(
        connection,
        this.sessions,
        (message) => {
          entry.relayError = message
          this.localChanged(id, entry)
        },
        () => this.store.effectiveDeviceName,
        (payload) => this.showNotification(id, payload)
      )
      await entry.relay.connect()
      void this.startTerminal(id, entry)
    } catch (error) {
      if (this.local.get(id) === entry && !this.stopped) {
        entry.relayError = String(error)
        this.localChanged(id, entry)
        entry.retry = setTimeout(() => {
          if (this.local.get(id) !== entry || this.stopped) return
          this.local.delete(id)
          void this.ensureLocal(id)
        }, 30000)
      }
    }
  }

  private async startLocalTerminal(): Promise<void> {
    if (!this.store.localServer.enabled || this.stopped || this.updatingRuntime) return
    let entry = this.local.get(null)
    if (!entry) {
      entry = {}
      this.local.set(null, entry)
    }
    await this.startTerminal(null, entry)
  }

  private async startTerminal(id: string | null, entry: LocalConnection): Promise<void> {
    if (
      !this.store.localServer.enabled ||
      this.stopped ||
      this.updatingRuntime ||
      this.local.get(id) !== entry ||
      (id !== null && !entry.relay) ||
      entry.starting ||
      entry.handle
    )
      return
    entry.starting = true
    clearTimeout(entry.retry)
    entry.retry = undefined
    try {
      const handle = await this.terminal.start(id, () => {})
      if (
        this.local.get(id) !== entry ||
        this.stopped ||
        this.updatingRuntime ||
        (id !== null && !this.sessions.credential(id))
      ) {
        await handle.stop()
        return
      }
      entry.handle = handle
      entry.terminalError = ''
      if (id !== null)
        entry.relay?.setService('open_terminal', (path, websocket) =>
          this.terminal.destination(id, path, websocket)
        )
      this.localChanged(id, entry)
      const unsubscribe = handle.service.subscribe((event) => {
        if (event.type !== 'state' || event.info.pid !== null || event.info.status === 'starting')
          return
        unsubscribe()
        if (entry.handle !== handle) return
        entry.handle = undefined
        entry.relay?.setService('open_terminal')
        if (this.local.get(id) === entry && !this.stopped && !this.updatingRuntime) {
          entry.terminalError = 'Open Terminal stopped. Restarting.'
          this.localChanged(id, entry)
          entry.retry = setTimeout(() => void this.startTerminal(id, entry), 5000)
        }
      })
    } catch (error) {
      if (this.local.get(id) === entry && !this.stopped && !this.updatingRuntime) {
        entry.terminalError = String(error)
        this.localChanged(id, entry)
        entry.retry = setTimeout(() => void this.startTerminal(id, entry), 30000)
      }
    } finally {
      entry.starting = false
    }
  }

  async reset(): Promise<void> {
    await this.stop()
    for (const view of this.views.values()) {
      this.window?.contentView.removeChildView(view)
      view.webContents.close()
    }
    this.views.clear()
    await Promise.all(Object.keys(this.store.credentials).map((id) => this.sessions.signedOut(id)))
    await this.store.requestReset()
  }

  async stop(): Promise<void> {
    this.pendingEvent?.finish('Tether is shutting down. Your handoff was not confirmed.')
    this.stopped = true
    this.sessions.stop()
    for (const notification of this.notifications.values()) notification.close()
    this.notifications.clear()
    for (const local of this.local.values()) {
      clearTimeout(local.retry)
      local.relay?.stop()
    }
    await Promise.all([this.terminal.stop(), this.localShell.shutdown()])
  }
}
