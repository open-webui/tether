/// <reference types="vite/client" />

import { BrowserWindow } from 'electron'
import type { TooltipInfo } from '../shared/api'
import baseStyle from 'tippy.js/dist/tippy.css?raw'
import theme from '../renderer/src/tooltip.css?raw'

let popup: BrowserWindow | null = null
let request = 0

function hide(): void {
  request++
  popup?.hide()
}

export async function setTooltip(owner: BrowserWindow | null, value: unknown): Promise<void> {
  hide()
  if (!owner?.isVisible() || value === null) return
  const info = value as TooltipInfo
  if (
    !info ||
    typeof info.text !== 'string' ||
    info.text.length > 4096 ||
    ![info.x, info.y, info.width, info.height].every(Number.isFinite) ||
    info.width <= 0 ||
    info.height <= 0
  )
    throw new Error('Invalid tooltip')

  // Renderer tooltips cannot paint over a native WebContentsView.
  const overlapsView = owner.contentView.children.some((view) => {
    const bounds = view.getBounds()
    return (
      view.getVisible() &&
      info.x < bounds.x + bounds.width &&
      info.x + info.width > bounds.x &&
      info.y < bounds.y + bounds.height &&
      info.y + info.height > bounds.y
    )
  })
  if (!overlapsView) return
  const bounds = owner.getContentBounds()
  if (
    info.x < 0 ||
    info.y < 0 ||
    info.x + info.width > bounds.width + 1 ||
    info.y + info.height > bounds.height + 1
  )
    return
  if (!popup) {
    popup = new BrowserWindow({
      parent: owner,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      // Otherwise macOS can fullscreen this child with its owner, leaving a black Space on hide.
      fullscreenable: false,
      hiddenInMissionControl: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    popup.setIgnoreMouseEvents(true)
    owner.on('blur', hide)
    owner.on('hide', hide)
    owner.on('minimize', hide)
    owner.on('resize', hide)
    owner.on('move', hide)
    owner.webContents.on('did-start-loading', hide)
    popup.on('closed', () => {
      popup = null
      request++
      owner.removeListener('blur', hide)
      owner.removeListener('hide', hide)
      owner.removeListener('minimize', hide)
      owner.removeListener('resize', hide)
      owner.removeListener('move', hide)
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.removeListener('did-start-loading', hide)
    })
  }
  const window = popup
  const current = request
  const padding = 32
  window.setBounds({
    x: bounds.x + Math.floor(info.x) - padding,
    y: bounds.y + Math.floor(info.y) - padding,
    width: Math.ceil(info.width) + padding * 2,
    height: Math.ceil(info.height) + padding * 2
  })
  const text = info.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${baseStyle}\n${theme}\n*{box-sizing:border-box}body{margin:${padding}px;background:transparent}.tippy-box{width:${info.width}px}</style><div class="tippy-box" data-theme="dark" data-state="visible"><div class="tippy-content">${text}</div></div>`
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    if (current === request && !window.isDestroyed() && owner.isVisible()) window.showInactive()
  } catch (error) {
    if (current === request && !window.isDestroyed()) throw error
  }
}
