import { BrowserWindow, type Session } from 'electron'
import { belongsToConnection, type Connection } from '../shared/connections'

export function isAccessLogin(address: string, connectionURL: string): boolean {
  try {
    const url = new URL(address)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (/^[^.]+\.cloudflareaccess\.com$/.test(url.hostname) ||
        url.origin === new URL(connectionURL).origin) &&
      /^\/cdn-cgi\/access\/login(?:\/|$)/.test(url.pathname)
    )
  } catch {
    return false
  }
}

export async function accessCookies(profile: Session, url: string): Promise<Electron.Cookie[]> {
  return (await profile.cookies.get({ url })).filter((cookie) =>
    ['CF_Authorization', 'CF_Binding'].includes(cookie.name)
  )
}

export async function accessHeaders(
  profile: Session,
  url: string
): Promise<Record<string, string>> {
  const cookies = await accessCookies(profile, url)
  return cookies.length
    ? { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') }
    : {}
}

export async function signInToAccess(
  connection: Connection,
  profile: Session,
  address: string
): Promise<void> {
  if (!isAccessLogin(address, connection.url)) throw new Error('Invalid Access login address.')
  const preferences = {
    session: profile,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
  const window = new BrowserWindow({
    width: 600,
    height: 760,
    title: 'Sign in to ' + new URL(connection.url).host,
    webPreferences: preferences
  })
  await new Promise<void>((resolve, reject) => {
    const windows = new Set([window])
    let finished = false
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const popup of windows) if (!popup.isDestroyed()) popup.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Access sign-in timed out.')), 600000)
    const attach = (popup: BrowserWindow): void => {
      windows.add(popup)
      const navigate = (event: Electron.Event, url: string): void => {
        if (!url.startsWith('https://') && !belongsToConnection(url, connection.url))
          event.preventDefault()
      }
      popup.webContents.on('will-navigate', navigate)
      popup.webContents.on('will-redirect', navigate)
      popup.webContents.setWindowOpenHandler(({ url }) =>
        url === 'about:blank' || url.startsWith('https://')
          ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: preferences } }
          : { action: 'deny' }
      )
      popup.webContents.on('did-create-window', attach)
      popup.webContents.on('did-navigate', (_event, url) => {
        if (belongsToConnection(url, connection.url)) finish()
      })
      popup.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) finish(new Error(description))
      })
    }
    attach(window)
    window.on('closed', () => finish(new Error('Access sign-in cancelled.')))
    void window.loadURL(address).catch((error) => {
      if (error.code !== 'ERR_ABORTED') finish(error)
    })
  })
}
