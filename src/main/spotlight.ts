import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeTheme,
  screen,
  systemPreferences,
  type Display,
  type NativeImage,
  type Rectangle
} from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Connections } from './connections'
import type { Connection } from '../shared/connections'
import { parseGeneralConfig } from '../shared/config'
import type { SpotlightInit } from '../shared/spotlight'
import type { TetherEvent } from '../shared/events'

// Ported from Desktop v0.0.20: a transparent display-sized window and a draggable input bar.
export class Spotlight {
  private window?: BrowserWindow
  private display?: Display
  private loading?: Promise<void>
  private generation = 0
  private capturing = false
  private submitting = false
  private stopped = false
  private openedAt = 0
  private snapshot?: NativeImage
  private useScreenPicker =
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)

  constructor(
    private connections: Connections,
    private showMain: () => void,
    private hideMain: () => void
  ) {}

  initialize(): void {
    const handle = (channel: string, callback: (...args: never[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => {
        if (this.stopped) throw new Error('Tether is shutting down.')
        if (
          event.sender !== this.window?.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error('Unknown Spotlight sender')
        return callback(...(args as never[]))
      })
    }
    handle('spotlight:close', () => this.hide())
    handle('spotlight:addConnection', async () => {
      this.hide()
      this.showMain()
      await this.connections.showConnection(null)
    })
    handle('spotlight:event', async (connection: Connection, event: TetherEvent) => {
      if (this.submitting) throw new Error('A handoff is already in progress.')
      this.submitting = true
      this.hide()
      this.showMain()
      try {
        await this.connections.sendEvent(connection, event)
      } catch (error) {
        if (!this.stopped && !this.window?.isVisible()) await this.toggle()
        throw error
      } finally {
        this.submitting = false
      }
    })
    handle('spotlight:capture', (rect?: Rectangle) => this.capture(rect))
    handle('spotlight:position', async (position: { x: number; y: number }) => {
      const config = parseGeneralConfig({
        ...this.connections.store.general,
        spotlightPosition: position
      })
      this.connections.store.general.spotlightPosition = config.spotlightPosition
      await this.connections.store.saveConfig()
    })
  }

  async toggle(): Promise<void> {
    if (this.stopped) return
    if (this.window?.isVisible()) {
      this.hide()
      return
    }
    if (this.loading) return
    if (!this.window) {
      const window = new BrowserWindow({
        title: 'Tether Spotlight',
        frame: false,
        transparent: true,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        webPreferences: {
          preload: join(__dirname, '../preload/spotlight.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      this.window = window
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.on('blur', () => {
        if (!this.capturing && Date.now() - this.openedAt > 200) this.hide()
      })
      window.on('close', (event) => {
        event.preventDefault()
        this.hide()
      })
      window.on('closed', () => {
        this.window = undefined
      })
      this.loading =
        is.dev && process.env.ELECTRON_RENDERER_URL
          ? window.loadURL(new URL('spotlight.html', process.env.ELECTRON_RENDERER_URL).href)
          : window.loadFile(join(__dirname, '../renderer/spotlight.html'))
      try {
        await this.loading
      } catch (error) {
        window.destroy()
        throw error
      } finally {
        this.loading = undefined
      }
    }
    if (this.stopped) return
    const window = this.window!
    this.hideMain()
    this.display = this.useScreenPicker
      ? screen.getPrimaryDisplay()
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    this.snapshot = undefined
    this.generation++
    window.setBounds(this.display.bounds)
    const store = this.connections.store
    const init: SpotlightInit = {
      language: store.general.language || app.getLocale(),
      connections: store.connections,
      selected: store.selected,
      width: this.display.bounds.width,
      height: this.display.bounds.height,
      position: store.general.spotlightPosition,
      dark: nativeTheme.shouldUseDarkColors,
      clipboard: store.general.spotlightClipboardPaste
        ? (await clipboard.readText().catch(() => '')).slice(0, 100_000)
        : '',
      useScreenPicker: this.useScreenPicker
    }
    if (this.stopped || window.isDestroyed()) return
    this.openedAt = Date.now()
    window.show()
    window.focus()
    window.webContents.focus()
    window.webContents.send('spotlight:init', init)
  }

  hide(): void {
    this.generation++
    this.snapshot = undefined
    this.window?.webContents.send('spotlight:hide')
    this.window?.hide()
  }

  destroy(): void {
    this.stopped = true
    this.generation++
    this.snapshot = undefined
    this.window?.destroy()
  }

  private async capture(rect?: Rectangle): Promise<string> {
    const window = this.window
    const display = this.display
    if (!window?.isVisible() || !display || this.capturing)
      throw new Error('Open Spotlight to capture a screenshot.')
    if (
      rect &&
      (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width < 1 ||
        rect.height < 1 ||
        rect.x + rect.width > display.bounds.width ||
        rect.y + rect.height > display.bounds.height)
    )
      throw new Error('Select a region inside this display.')
    const generation = this.generation
    this.capturing = true
    try {
      let image = rect ? this.snapshot : undefined
      if (!image) {
        if (
          process.platform === 'darwin' &&
          systemPreferences.getMediaAccessStatus('screen') === 'denied'
        )
          throw new Error(
            'Allow Tether in System Settings → Privacy & Security → Screen Recording, then reopen Tether.'
          )
        if (this.useScreenPicker) window.hide()
        else window.setOpacity(0)
        await new Promise((resolve) => setTimeout(resolve, 150))
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(display.bounds.width * display.scaleFactor),
            height: Math.round(display.bounds.height * display.scaleFactor)
          }
        })
        // PipeWire returns the user's portal selection; preview it before choosing a region.
        const source =
          this.useScreenPicker && sources.length === 1
            ? sources[0]
            : sources.find((source) => source.display_id === String(display.id))
        if (!source || source.thumbnail.isEmpty())
          throw new Error(
            'Could not capture this display. Check screen recording permission and try again.'
          )
        image = source.thumbnail
      }
      if (generation !== this.generation) throw new Error('Screenshot cancelled.')
      if (!rect) {
        this.snapshot = image
        return image.toDataURL()
      }
      const size = image.getSize()
      const x = Math.min(size.width - 1, Math.round((rect.x * size.width) / display.bounds.width))
      const y = Math.min(
        size.height - 1,
        Math.round((rect.y * size.height) / display.bounds.height)
      )
      const right = Math.round(((rect.x + rect.width) * size.width) / display.bounds.width)
      const bottom = Math.round(((rect.y + rect.height) * size.height) / display.bounds.height)
      this.snapshot = undefined
      return image
        .crop({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) })
        .toDataURL()
    } finally {
      this.capturing = false
      if (!window.isDestroyed()) {
        if (this.useScreenPicker && generation === this.generation) window.show()
        window.setOpacity(1)
        if (window.isVisible()) window.focus()
      }
    }
  }
}
