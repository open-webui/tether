import { app, safeStorage } from 'electron'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, X509Certificate } from 'node:crypto'
import { hostname } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  defaultGeneralConfig,
  parseGeneralConfig,
  parseLocalServerConfig,
  type GeneralConfig,
  type LocalServerConfig
} from '../shared/config'
import { normalizeURL, type Connection } from '../shared/connections'

export interface Credential {
  userId: string
  token: string
  expiresAt: number | null
  sessionId?: string
  refreshToken?: string
  refreshRequestId?: string
  refreshExpiresAt?: number
}

export class Store {
  get effectiveDeviceName(): string {
    return this.general.deviceName || this.deviceName
  }

  deviceName = hostname().trim().slice(0, 100) || 'This computer'
  connections: Connection[] = []
  selected: string | null = null
  general: GeneralConfig = { ...defaultGeneralConfig }
  localServer: LocalServerConfig = {
    sandbox: { enabled: false, workspacePath: '', networkAccess: false },
    enabled: false,
    version: '',
    autoUpdate: false,
    httpEnabled: false,
    httpHost: '127.0.0.1'
  }
  credentials: Record<string, Credential> = {}
  persistentCredentials = false
  private queue: Promise<void> = Promise.resolve()
  private resetting = false
  private directory = join(app.getPath('userData'), 'data')
  private resetPath = join(app.getPath('userData'), 'reset')

  async load(): Promise<void> {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await promisify(execFile)(
          '/usr/sbin/scutil',
          ['--get', 'ComputerName'],
          { timeout: 1000 }
        )
        this.deviceName = stdout.trim().slice(0, 100) || this.deviceName
      } catch {
        // Use the hostname if the friendly computer name is unavailable.
      }
    }
    const reset = await access(this.resetPath).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false
        throw error
      }
    )
    if (reset) {
      // Run before opening browser profiles, which remain locked until exit on Windows.
      for (const name of ['python', 'node', 'profiles'])
        await rm(join(app.getPath('userData'), name), { recursive: true, force: true })
      // Remove the marker last so interrupted resets finish on the next launch.
      await rm(this.directory, { recursive: true, force: true })
      await rm(this.resetPath)
    }
    await mkdir(this.directory, { recursive: true })
    try {
      const config = JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8'))
      this.general = parseGeneralConfig(config)
      if (config.localServer) this.localServer = parseLocalServerConfig(config.localServer)
      if (!Array.isArray(config.connections)) throw new Error('Invalid connection configuration')
      this.connections = config.connections.map((value: Connection) => {
        if (!/^[a-f0-9-]{36}$/i.test(value.id) || typeof value.name !== 'string') {
          throw new Error('Invalid saved connection')
        }
        const trustedCertificate = value.trustedCertificate
        if (trustedCertificate !== undefined) {
          if (typeof trustedCertificate !== 'string') throw new Error('Invalid saved certificate')
          new X509Certificate(trustedCertificate)
        }
        return { id: value.id, name: value.name, url: normalizeURL(value.url), trustedCertificate }
      })
      if (new Set(this.connections.map((c) => c.id)).size !== this.connections.length) {
        throw new Error('Duplicate connection identifiers')
      }
      this.selected = this.connections.some((c) => c.id === config.selected)
        ? config.selected
        : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.persistentCredentials = await safeStorage.isAsyncEncryptionAvailable()
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      this.persistentCredentials = false
    }
    if (!this.persistentCredentials) return
    try {
      const encrypted = await readFile(join(this.directory, 'credentials.enc'))
      const decrypted = await safeStorage.decryptStringAsync(encrypted)
      const values = JSON.parse(decrypted.result)
      for (const connection of this.connections) {
        const value = values[connection.id]
        if (value && typeof value.token === 'string' && typeof value.userId === 'string') {
          this.credentials[connection.id] = value
        }
      }
      if (decrypted.shouldReEncrypt) await this.saveCredentials()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private write(name: string, content: () => Promise<string | Buffer>): Promise<void> {
    if (this.resetting) return Promise.reject(new Error('Tether is resetting.'))
    const operation = this.queue.then(async () => {
      const temporary = join(this.directory, name + '.' + randomUUID() + '.tmp')
      try {
        await writeFile(temporary, await content(), { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, name))
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  async requestReset(): Promise<void> {
    this.resetting = true
    await this.queue
    try {
      await writeFile(this.resetPath, '', { mode: 0o600 })
    } catch (error) {
      this.resetting = false
      throw error
    }
  }

  saveConfig(): Promise<void> {
    const value = JSON.stringify({
      ...this.general,
      connections: this.connections,
      selected: this.selected,
      localServer: this.localServer
    })
    return this.write('config.json', async () => value)
  }

  saveCredentials(): Promise<void> {
    if (!this.persistentCredentials) return Promise.resolve()
    const value = JSON.stringify(this.credentials)
    return this.write('credentials.enc', () => safeStorage.encryptStringAsync(value))
  }
}
