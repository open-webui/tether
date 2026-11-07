import { t } from './i18n'
import { app } from 'electron'
import log from 'electron-log'
import { randomBytes } from 'node:crypto'
import { access, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { LocalServerConfig, RuntimeState } from '../shared/config'
import type { ServiceStatus } from '../shared/terminal'
import { Runtime } from './runtime'
import type { RelayDestination } from './relay'
import { ManagedService, waitForReady } from './process/managedService'
import { spawnPty } from './process/nativePty'

export interface TerminalHandle {
  url: string
  key: string
  capabilities: Record<string, boolean>
  service: ManagedService
  stop(): Promise<void>
}

export class OpenTerminal {
  private closed = false
  private installation?: Promise<void>
  private state: RuntimeState = { version: null, status: '', busy: false, error: '' }
  private runtime = new Runtime('python', (data) => this.append(data))
  private services = new Map<string | null, ManagedService>()
  private handles = new Map<string | null, TerminalHandle>()

  constructor(
    private getConfig: () => LocalServerConfig = () => ({
      enabled: false,
      version: '',
      autoUpdate: false
    }),
    private changed: (state: RuntimeState) => void = () => {},
    private output: (id: string | null, data: string) => void = () => {}
  ) {}

  async getState(): Promise<RuntimeState> {
    if (!this.state.busy) this.state.version = await this.runtime.getPackageVersion('open-terminal')
    return { ...this.state }
  }

  private setState(value: Partial<RuntimeState>): void {
    Object.assign(this.state, value)
    this.changed({ ...this.state })
  }

  private environment(): NodeJS.ProcessEnv {
    const env = Object.fromEntries(
      Object.entries(this.runtime.environment()).filter(([key]) => !/^OPEN_TERMINAL_/i.test(key))
    )
    // Finder launches do not inherit a shell's PATH; native agent CLIs still need their runtimes.
    env.PATH = [
      env.PATH ?? '',
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.cursor', 'bin'),
      join(homedir(), '.opencode', 'bin'),
      ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])
    ].join(delimiter)
    return env
  }

  destination(id: string, path: string, websocket: boolean): RelayDestination {
    const handle = this.handles.get(id)
    if (!handle || handle.service.info.status !== 'started')
      throw new Error('Open Terminal is unavailable')
    const url = new URL(path, handle.url)
    if (/^\/(?:admin|api\/admin|notebooks)(?:\/|$)/.test(decodeURIComponent(url.pathname)))
      throw new Error('Forbidden terminal path')
    return {
      url: handle.url,
      headers: { Authorization: 'Bearer ' + handle.key },
      ...(websocket && !url.pathname.startsWith('/browser/view/')
        ? {
            firstMessage: (data: Buffer, kind: string): Buffer => {
              if (kind !== 'text') throw new Error('Expected terminal authentication')
              const auth = JSON.parse(data.toString())
              if (auth.type !== 'auth') throw new Error('Expected terminal authentication')
              return Buffer.from(JSON.stringify({ ...auth, token: handle.key }))
            }
          }
        : {})
    }
  }

  async restart(): Promise<void> {
    await Promise.all([...this.services.values()].map((service) => service.stop()))
  }

  async installPackage(): Promise<void> {
    if (this.closed) throw new Error('Open Terminal is shutting down')
    const stopped = this.runtime.stop()
    await Promise.all([stopped, ...[...this.services.values()].map((service) => service.stop())])
    await this.installation?.catch(() => {})
    if (this.closed) throw new Error('Open Terminal is shutting down')
    this.installation = undefined
    this.runtime = new Runtime('python', (data) => this.append(data))
    await this.install(() => {}, true)
  }

  async uninstallPackage(): Promise<void> {
    if (this.closed) throw new Error('Open Terminal is shutting down')
    const stopped = this.runtime.stop()
    await Promise.all([stopped, ...[...this.services.values()].map((service) => service.stop())])
    await this.installation?.catch(() => {})
    if (this.closed) throw new Error('Open Terminal is shutting down')
    this.installation = undefined
    this.handles.clear()
    this.runtime = new Runtime('python', (data) => this.append(data))
    this.setState({ busy: true, status: t('terminal.uninstalling'), error: '' })
    try {
      await this.runtime.uninstallPackage('open-terminal', (status) => this.setState({ status }))
      await rm(join(this.runtime.directory, '.install-incomplete'), { force: true })
      this.setState({ version: null })
    } catch (error) {
      this.setState({ error: String(error).replace(/^Error: /, '') })
      throw error
    } finally {
      this.setState({ busy: false, status: '' })
    }
  }

  getStatus(id: string | null): ServiceStatus {
    const status = this.services.get(id)?.info.status
    if (status && status !== 'stopped') return status
    return this.services.get(null)?.info.status ?? 'stopped'
  }

  getService(id: string | null): ManagedService {
    let service = this.services.get(id)
    if (!service) {
      service = new ManagedService((launch) => {
        const child = spawnPty(launch)
        const key = launch.env.OPEN_TERMINAL_API_KEY
        return {
          ...child,
          onData: (callback) =>
            child.onData((data) => callback(key ? data.replaceAll(key, '[redacted]') : data))
        }
      })
      service.subscribe((event) => {
        if (event.type === 'output') {
          log.info('[terminal ' + (id ?? 'setup') + '] ' + event.data)
          this.output(id, event.data)
        } else if (event.type === 'state') {
          this.changed({ ...this.state })
        }
      })
      if (id !== null) service.append(this.getService(null).logs)
      this.services.set(id, service)
    }
    return service
  }

  private append(data: string): void {
    this.getService(null)
    for (const service of this.services.values()) service.append(data)
  }

  async remove(id: string): Promise<void> {
    const service = this.services.get(id)
    await service?.shutdown()
    this.services.delete(id)
    this.handles.delete(id)
  }

  private install(status: (message: string) => void, update = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Open Terminal is shutting down'))
    if (!this.installation) {
      this.setState({ busy: true, error: '' })
      this.append('Preparing Open Terminal\r\n')
      this.installation = this.installOnce((message) => {
        this.setState({ status: message })
        status(message)
      }, update)
        .catch((error) => {
          this.installation = undefined
          this.setState({ error: String(error).replace(/^Error: /, '') })
          this.append(String(error) + '\r\n')
          throw error
        })
        .finally(() => this.setState({ busy: false, status: '' }))
    }
    return this.installation
  }

  private async installOnce(status: (message: string) => void, update: boolean): Promise<void> {
    await this.runtime.install(status)
    this.runtime.signal.throwIfAborted()
    const config = this.getConfig()
    const installed = await this.runtime.getPackageVersion('open-terminal')
    const marker = join(this.runtime.directory, '.install-incomplete')
    const repair = await access(marker).then(
      () => true,
      () => false
    )
    if (
      update ||
      repair ||
      !installed ||
      (config.version ? config.version !== installed : config.autoUpdate)
    ) {
      // Like Desktop, an interrupted package change must be repaired before starting the service.
      await writeFile(marker, '', { mode: 0o600 })
      status(installed ? t('terminal.updating') : t('terminal.installing'))
      await this.runtime.installPackage('open-terminal', config.version, repair, status)
      await this.runtime.execute(['-c', 'import open_terminal, uvicorn'], this.environment())
      await rm(marker, { force: true })
    }
    const version = await this.runtime.getPackageVersion('open-terminal')
    this.setState({ version })
    const { stdout } = await this.runtime.execute(
      ['-m', 'open_terminal', 'run', '--help'],
      this.environment()
    )
    if (!stdout.includes('--isolated')) {
      throw new Error(
        `Open Terminal ${version} lacks Tether's isolated configuration support. A compatible Open Terminal release is required.`
      )
    }
  }

  async start(id: string | null, status: (message: string) => void): Promise<TerminalHandle> {
    const service = this.getService(id)
    await service.start(async (signal) => {
      await this.install(status)
      signal.throwIfAborted()
      this.runtime.signal.throwIfAborted()
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') {
            server.close()
            reject(new Error('No local port available'))
            return
          }
          server.close(() => resolve(address.port))
        })
      })
      const key = randomBytes(48).toString('base64url')
      const url = 'http://127.0.0.1:' + port
      const handle: TerminalHandle = {
        url,
        key,
        capabilities: {},
        service,
        stop: () => service.stop()
      }
      this.handles.set(id, handle)
      return {
        file: this.runtime.executable,
        args: [
          '-m',
          'open_terminal',
          'run',
          '--isolated',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--cors-allowed-origins',
          ''
        ],
        cwd: this.getConfig().homeDirectory || homedir(),
        env: Object.fromEntries(
          Object.entries({
            ...this.environment(),
            ...this.getConfig().env,
            OPEN_TERMINAL_ISOLATED: 'true',
            OPEN_TERMINAL_API_KEY: key,
            OPEN_TERMINAL_ENABLE_NOTEBOOKS: 'false',
            OPEN_TERMINAL_MULTI_USER: 'false',
            OPEN_TERMINAL_CORS_ALLOWED_ORIGINS: '',
            OPEN_TERMINAL_LOG_DIR: join(app.getPath('logs'), 'terminal', id ?? 'local')
          }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        ),
        url,
        ready: (signal) =>
          waitForReady(
            async (signal) => {
              const response = await fetch(url + '/files/cwd', {
                headers: { Authorization: 'Bearer ' + key },
                signal
              })
              if (!response.ok) return false
              const configResponse = await fetch(url + '/api/config', { signal })
              if (!configResponse.ok) return false
              const config = (await configResponse.json()) as { features?: Record<string, boolean> }
              handle.capabilities = { files: true, ...config.features }
              return true
            },
            signal,
            20000,
            200
          )
      }
    })
    return this.handles.get(id)!
  }

  async stop(): Promise<void> {
    this.closed = true
    const stopped = this.runtime.stop()
    await Promise.all([
      stopped,
      ...[...this.services.values()].map((service) => service.shutdown())
    ])
    await this.installation?.catch(() => {})
  }
}
