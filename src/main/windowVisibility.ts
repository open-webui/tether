import type { BrowserWindow } from 'electron'

const pendingHides = new WeakMap<BrowserWindow, { promise: Promise<boolean>; cancel: () => void }>()

export function cancelWindowHide(window: BrowserWindow): void {
  pendingHides.get(window)?.cancel()
}

export function hideWindow(window: BrowserWindow): Promise<boolean> {
  const pending = pendingHides.get(window)
  if (pending) return pending.promise
  if (window.isDestroyed()) return Promise.resolve(false)
  if (process.platform !== 'darwin' || !window.isFullScreen()) {
    window.hide()
    return Promise.resolve(true)
  }

  // Hiding a native fullscreen macOS window leaves a black Space (Electron #39572).
  let finish!: (hidden: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  const cleanup = (): void => {
    window.removeListener('leave-full-screen', hide)
    window.removeListener('closed', cancel)
    pendingHides.delete(window)
  }
  const cancel = (): void => {
    cleanup()
    finish(false)
  }
  const hide = (): void => {
    cleanup()
    const hidden = !window.isDestroyed()
    if (hidden) window.hide()
    finish(hidden)
  }
  pendingHides.set(window, { promise, cancel })
  window.once('leave-full-screen', hide)
  window.once('closed', cancel)
  try {
    window.setFullScreen(false)
  } catch (error) {
    cancel()
    return Promise.reject(error)
  }
  return promise
}
