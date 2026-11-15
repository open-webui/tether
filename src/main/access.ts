import { BrowserWindow, type Session } from 'electron'
import { belongsToConnection, type Connection } from '../shared/connections'
import { connectionHeaders } from '../shared/connectionHeaders'

export function configureAccessHeaders(profile: Session, connection: Connection): void {
  const scoped = { ...connection, headers: { ...connection.headers } }
  const names = new Set(Object.keys(scoped.headers))
  if (!names.size) return
  profile.webRequest.onBeforeSendHeaders((details, callback) => {
    // Redirects can carry custom headers forward, so strip them before reapplying the scope.
    const headers = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => !names.has(name.toLowerCase()))
    )
    callback({ requestHeaders: { ...headers, ...connectionHeaders(scoped, details.url) } })
  })
}

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
  return profile.cookies.get({ url })
}

export async function accessHeaders(
  profile: Session,
  url: string,
  connection: Connection
): Promise<Record<string, string>> {
  const cookies = await accessCookies(profile, url)
  return {
    ...connectionHeaders(connection, url),
    ...(cookies.length
      ? { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') }
      : {})
  }
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
        if (
          belongsToConnection(url, connection.url) &&
          !/^\/cdn-cgi\/access(?:\/|$)/.test(new URL(url).pathname)
        )
          finish()
      })
      popup.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) finish(new Error(description))
      })
    }
    attach(window)
    window.on('closed', () => finish(new Error('Access sign-in cancelled.')))
    // Start in this session so Access's login state and callback cookies stay together.
    void window.loadURL(connection.url).catch((error) => {
      if (error.code !== 'ERR_ABORTED') finish(error)
    })
  })
}
