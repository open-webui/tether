import { shell } from 'electron'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { endpoint, type AccessToken, type Connection } from '../shared/connections'
import { Store, type Credential } from './store'
import { connectionSession } from './network'
import { accessHeaders } from './access'

interface SessionResponse {
  session_id: string
  token: string
  expires_at: number
  refresh_token: string
  refresh_expires_at: number
}

class RequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403 ? 'Sign in again.' : 'WebUI request failed (' + status + ').'
    )
  }
}

export class Sessions {
  private pending = new Map<string, Promise<AccessToken | null>>()
  private versions = new Map<string, number>()
  private browsers = new Map<string, () => void>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private store: Store,
    private changed: (id: string, access: AccessToken | null) => void,
    private failed: (id: string, message: string) => void
  ) {}

  private connection(id: string): Connection {
    const connection = this.store.connections.find((item) => item.id === id)
    if (!connection) throw new Error('Unknown connection')
    return connection
  }

  private async request<T>(
    id: string,
    path: string,
    token?: string,
    body?: unknown,
    method?: string
  ): Promise<T> {
    const connection = this.connection(id)
    const response = await connectionSession(connection).fetch(endpoint(connection.url, path), {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'omit',
      headers: {
        ...(await accessHeaders(connectionSession(connection), endpoint(connection.url, path))),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) throw new RequestError(response.status)
    return response.json() as Promise<T>
  }

  private unchanged(id: string, version: number): void {
    this.connection(id)
    if ((this.versions.get(id) ?? 0) !== version) throw new Error('Login was cancelled')
  }

  private async accept(
    id: string,
    response: SessionResponse,
    userId: string,
    version: number
  ): Promise<AccessToken> {
    this.unchanged(id, version)
    if (
      !response.token ||
      !response.refresh_token ||
      !response.session_id ||
      !Number.isFinite(response.expires_at)
    ) {
      throw new Error('Invalid session response')
    }
    const previous = this.store.credentials[id]
    const credential: Credential = {
      userId,
      sessionId: response.session_id,
      token: response.token,
      expiresAt: response.expires_at,
      refreshToken: response.refresh_token,
      refreshExpiresAt: response.refresh_expires_at
    }
    this.store.credentials[id] = credential
    try {
      await this.store.saveCredentials()
    } catch (error) {
      // Keep the pending refresh recoverable if saving its replacement fails.
      if (this.store.credentials[id] === credential) {
        if (previous) this.store.credentials[id] = previous
        else delete this.store.credentials[id]
      }
      throw error
    }
    this.unchanged(id, version)
    const access = { token: response.token, expiresAt: response.expires_at }
    this.changed(id, access)
    return access
  }

  async signedIn(id: string, token: string): Promise<AccessToken> {
    if (typeof token !== 'string' || !token || token.length > 16384)
      throw new Error('Invalid token')
    const existing = this.store.credentials[id]
    if (existing?.token === token) return { token, expiresAt: existing.expiresAt }
    const version = this.versions.get(id) ?? 0
    const info = await this.request<{ id: string; role: string; expires_at: number | null }>(
      id,
      'api/v1/auths/',
      token
    )
    this.unchanged(id, version)
    if (!['user', 'admin'].includes(info.role)) throw new Error('Account approval is required.')
    if (existing && existing.userId !== info.id)
      throw new Error('Sign out before changing accounts.')
    const config = await this.request<{ features?: { auth_sessions?: boolean } }>(
      id,
      'api/config',
      token
    )
    this.unchanged(id, version)
    if (config.features?.auth_sessions) {
      const response = await this.request<SessionResponse>(id, 'api/v1/auths/sessions', token, {
        name: this.store.effectiveDeviceName
      })
      return this.accept(id, response, info.id, version)
    }
    this.store.credentials[id] = { userId: info.id, token, expiresAt: info.expires_at }
    await this.store.saveCredentials()
    this.unchanged(id, version)
    const access = { token, expiresAt: info.expires_at }
    this.changed(id, access)
    return access
  }

  refresh(id: string, force = false): Promise<AccessToken | null> {
    const pending = this.pending.get(id)
    if (pending) return pending
    const operation = this.renew(id, force).finally(() => {
      if (this.pending.get(id) === operation) this.pending.delete(id)
    })
    this.pending.set(id, operation)
    return operation
  }

  private async renew(id: string, force: boolean): Promise<AccessToken | null> {
    const current = this.store.credentials[id]
    if (!current) return null
    const version = this.versions.get(id) ?? 0
    if (
      !force &&
      !current.refreshRequestId &&
      (current.expiresAt === null || current.expiresAt > Date.now() / 1000 + 90)
    ) {
      return { token: current.token, expiresAt: current.expiresAt }
    }
    if (!current.refreshToken) return { token: current.token, expiresAt: current.expiresAt }
    try {
      current.refreshRequestId ??= randomUUID()
      // Persist before sending so a restart can repeat the exact rotation request.
      await this.store.saveCredentials()
      this.unchanged(id, version)
      const response = await this.request<SessionResponse>(
        id,
        'api/v1/auths/sessions/refresh',
        undefined,
        {
          refresh_token: current.refreshToken,
          request_id: current.refreshRequestId
        }
      )
      return await this.accept(id, response, current.userId, version)
    } catch (error) {
      if (error instanceof RequestError && [401, 403].includes(error.status)) {
        this.unchanged(id, version)
        await this.signedOut(id, false)
      }
      throw error
    }
  }

  async signedOut(id: string, revoke = true): Promise<void> {
    const credential = this.store.credentials[id]
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    this.browsers.get(id)?.()
    this.pending.delete(id)
    delete this.store.credentials[id]
    this.changed(id, null)
    await this.store.saveCredentials()
    if (revoke && credential?.sessionId) {
      await this.request(
        id,
        'api/v1/auths/sessions/' + credential.sessionId,
        credential.token,
        undefined,
        'DELETE'
      ).catch(() => {
        this.failed(id, 'Signed out locally. WebUI was unavailable for session revocation.')
      })
    }
  }

  async signInWithBrowser(id: string, provider: string): Promise<boolean> {
    if (this.browsers.has(id)) throw new Error('Browser sign-in is already open.')
    const version = this.versions.get(id) ?? 0
    const connection = this.connection(id)
    const config = await this.request<{
      features?: { auth_sessions?: boolean }
      oauth?: { providers?: Record<string, unknown> }
    }>(id, 'api/config')
    this.unchanged(id, version)
    if (!Object.hasOwn(config.oauth?.providers ?? {}, provider))
      throw new Error('This WebUI does not support this sign-in provider.')
    if (
      !config.features?.auth_sessions ||
      (await accessHeaders(connectionSession(connection), endpoint(connection.url, 'api/config')))
        .Cookie
    )
      return false
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const path = '/callback/' + randomBytes(24).toString('base64url')
    const server = createServer()
    server.requestTimeout = 5000
    server.headersTimeout = 5000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not open sign-in callback')
    const redirectURI = 'http://127.0.0.1:' + address.port + path
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const callback = new Promise<string>((resolve, reject) => {
        this.browsers.set(id, () => reject(new Error('Browser sign-in cancelled')))
        timer = setTimeout(() => reject(new Error('Browser sign-in timed out')), 600000)
        server.on('error', reject)
        let consumed = false
        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirectURI)
          const returnedState = url.searchParams.get('state') ?? ''
          const code = url.searchParams.get('code')
          if (
            consumed ||
            request.method !== 'GET' ||
            url.pathname !== path ||
            returnedState.length !== state.length ||
            !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state)) ||
            !code ||
            code.length > 8192
          ) {
            response.writeHead(400).end('Invalid sign-in callback.')
            return
          }
          consumed = true
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'",
            'Referrer-Policy': 'no-referrer'
          })
          response.end('Return to Tether to finish signing in. You can close this tab.')
          resolve(code)
        })
      })
      // Attach a rejection handler before network setup, which can itself fail.
      void callback.catch(() => {})
      this.unchanged(id, version)
      const pending = await this.request<{ session_id: string }>(
        id,
        'api/v1/auths/sessions/requests',
        undefined,
        {
          name: this.store.effectiveDeviceName,
          redirect_uri: redirectURI,
          state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url')
        }
      )
      this.unchanged(id, version)
      await shell.openExternal(
        endpoint(connection.url, 'auth/sessions/' + encodeURIComponent(pending.session_id)) +
          '?provider=' +
          encodeURIComponent(provider)
      )
      const code = await callback
      this.unchanged(id, version)
      const result = await this.request<SessionResponse>(
        id,
        'api/v1/auths/sessions/exchange',
        undefined,
        {
          session_id: pending.session_id,
          code,
          code_verifier: verifier,
          redirect_uri: redirectURI
        }
      )
      this.unchanged(id, version)
      const info = await this.request<{ id: string }>(id, 'api/v1/auths/', result.token)
      const existing = this.store.credentials[id]
      if (existing && existing.userId !== info.id)
        throw new Error('Sign out before changing accounts.')
      await this.accept(id, result, info.id, version)
      return true
    } finally {
      clearTimeout(timer)
      this.browsers.delete(id)
      server.closeAllConnections()
      server.close()
    }
  }

  start(): void {
    const renew = (): void => {
      for (const id of Object.keys(this.store.credentials)) {
        void this.refresh(id).catch(() =>
          this.failed(
            id,
            this.store.credentials[id]
              ? 'Could not renew the connection. Retrying.'
              : 'Sign in again.'
          )
        )
      }
    }
    renew()
    this.timer = setInterval(renew, 30000)
  }

  stop(): void {
    clearInterval(this.timer)
    for (const cancel of this.browsers.values()) cancel()
    for (const connection of this.store.connections) {
      this.versions.set(connection.id, (this.versions.get(connection.id) ?? 0) + 1)
    }
  }

  credential(id: string): Credential | undefined {
    return this.store.credentials[id]
  }
}
