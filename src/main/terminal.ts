import { t } from './i18n'
import { app } from 'electron'
import log from 'electron-log'
import { randomBytes } from 'node:crypto'
import { access, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { LocalServerConfig, RuntimeState } from '../shared/config'
import type { ServiceStatus } from '../shared/terminal'
import { Runtime } from './runtime'
import type { RelayDestination } from './relay'
import { ManagedService, waitForReady } from './process/managedService'
import { spawnPty } from './process/nativePty'
import { createTerminalEndpoint, readTerminalJSON } from './process/terminalEndpoint'
import { getSandboxSupport, sandboxForbiddenPaths, spawnSandboxed } from './sandbox'
import {
  createSandboxPolicy,
  sandboxEnvironment,
  SandboxError,
  type SandboxPolicy
} from './sandbox/policy'
import { probeSandbox } from './sandbox/probe'

export interface TerminalHandle {
  url: string
  socketPath?: string
  httpUrl?: string
  cleanup(): Promise<void>
  key: string
  capabilities: Record<string, boolean>
  service: ManagedService
  stop(): Promise<void>
  sandbox?: SandboxPolicy
}

export class OpenTerminal {
  private closed = false
  private installation?: Promise<void>
  private supportsIPC = false
  private state: RuntimeState = { version: null, status: '', busy: false, error: '' }
  private runtime = new Runtime('python', (data) => this.append(data))
  private services = new Map<string | null, ManagedService>()
  private handles = new Map<string | null, TerminalHandle>()
  private cleanups = new Set<Promise<void>>()
  private cleanupError?: Error
  private policyRevision = 0

  constructor(
    private getConfig: () => LocalServerConfig = () => ({
      sandbox: { enabled: false, workspacePath: '', networkAccess: false },
      enabled: false,
      version: '',
      autoUpdate: false,
      httpEnabled: false,
      httpHost: '127.0.0.1'
    }),
    private changed: (state: RuntimeState) => void = () => {},
    private output: (id: string | null, data: string) => void = () => {}
  ) {}

  async getState(): Promise<RuntimeState> {
    if (!this.state.busy) this.state.version = await this.runtime.getPackageVersion('open-terminal')
    const support = await getSandboxSupport()
    const config = this.getConfig().sandbox
    this.state.sandbox = {
      active: false,
      workspacePath: config.workspacePath,
      networkAccess: config.networkAccess,
      policyRevision: this.policyRevision,
      ...this.state.sandbox,
      ...{ support }
    }
    return this.snapshot()
  }

  private snapshot(): RuntimeState {
    const config = this.getConfig().sandbox
    const sandbox = this.state.sandbox
    return {
      ...this.state,
      ...(sandbox
        ? {
            sandbox: {
              ...sandbox,
              active:
                config.enabled &&
                [...this.handles.values()].some(
                  (handle) =>
                    handle.sandbox?.policyRevision === this.policyRevision &&
                    handle.service.info.status === 'started'
                ),
              workspacePath: config.workspacePath,
              networkAccess: config.networkAccess,
              policyRevision: this.policyRevision
            }
          }
        : {})
    }
  }

  private setState(value: Partial<RuntimeState>): void {
    Object.assign(this.state, value)
    this.changed(this.snapshot())
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
    if (
      !handle ||
      handle.service.info.status !== 'started' ||
      (this.getConfig().sandbox.enabled && handle.sandbox?.policyRevision !== this.policyRevision)
    )
      throw new Error('Open Terminal is unavailable')
    const url = new URL(path, handle.url)
    if (/^\/(?:admin|api\/admin|notebooks)(?:\/|$)/.test(decodeURIComponent(url.pathname)))
      throw new Error('Forbidden terminal path')
    return {
      url: handle.url,
      socketPath: handle.socketPath,
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
    this.policyRevision++
    await Promise.all([...this.services.values()].map((service) => service.stop()))
    await Promise.all(this.cleanups)
    if (this.cleanupError) throw this.cleanupError
  }

  credentials(id: string | null): { url: string; apiKey: string } {
    const status = this.services.get(id)?.info.status
    const handle = this.handles.get(!status || status === 'stopped' ? null : id)
    if (
      this.getConfig().sandbox.enabled ||
      !this.getConfig().httpEnabled ||
      !handle?.httpUrl ||
      handle.service.info.status !== 'started'
    )
      throw new Error('HTTP access is not running for this connection.')
    return { url: handle.httpUrl, apiKey: handle.key }
  }

  async installPackage(): Promise<void> {
    if (this.closed) throw new Error('Open Terminal is shutting down')
    const stopped = this.runtime.stop()
    await Promise.all([stopped, ...[...this.services.values()].map((service) => service.stop())])
    await this.installation?.catch(() => {})
    await Promise.all(this.cleanups)
    if (this.cleanupError) throw this.cleanupError
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
    await Promise.all(this.cleanups)
    if (this.cleanupError) throw this.cleanupError
    if (this.closed) throw new Error('Open Terminal is shutting down')
    this.installation = undefined
    this.handles.clear()
    this.runtime = new Runtime('python', (data) => this.append(data))
    this.setState({ busy: true, status: t('terminal.uninstalling'), error: '' })
    try {
      await this.runtime.uninstallPackage('open-terminal', (status) => this.setState({ status }))
      await rm(join(this.runtime.directory, '.install-incomplete'), { force: true })
      this.setState({ version: null, ipcSupported: undefined })
    } catch (error) {
      this.setState({ error: String(error).replace(/^Error: /, '') })
      throw error
    } finally {
      this.setState({ busy: false, status: '' })
    }
  }

  getStatus(id: string | null): ServiceStatus {
    const status = this.services.get(id)?.info.status
    if (this.getConfig().sandbox.enabled) return status ?? 'stopped'
    if (status && status !== 'stopped') return status
    return this.services.get(null)?.info.status ?? 'stopped'
  }

  getService(id: string | null): ManagedService {
    let service = this.services.get(id)
    if (!service) {
      service = new ManagedService(async (launch, signal) => {
        const policy = this.handles.get(id)?.sandbox
        if (this.getConfig().sandbox.enabled && !policy)
          throw new SandboxError('Sandbox policy is missing. Open Terminal was not started.')
        if (policy) await probeSandbox(launch, policy, signal, spawnSandboxed)
        const child = policy ? await spawnSandboxed(launch, policy, signal) : spawnPty(launch)
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
          if (event.info.pid === null && ['stopped', 'failed'].includes(event.info.status)) {
            const handle = this.handles.get(id)
            if (handle) {
              const cleanup = handle.cleanup().catch((error) => {
                this.cleanupError = error instanceof Error ? error : new Error(String(error))
                log.warn('Terminal cleanup failed:', error)
              })
              this.cleanups.add(cleanup)
              void cleanup.finally(() => this.cleanups.delete(cleanup))
              this.handles.delete(id)
            }
          }
          this.changed(this.snapshot())
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
    this.supportsIPC = stdout.includes('--ipc')
    this.setState({ ipcSupported: this.supportsIPC })
  }

  async start(id: string | null, status: (message: string) => void): Promise<TerminalHandle> {
    if (this.cleanupError)
      throw new SandboxError(
        'A previous session could not be cleaned up. Restart Tether before starting another session.'
      )
    const service = this.getService(id)
    const revision = this.policyRevision
    try {
      await service.start(async (signal) => {
        await this.install(status)
        signal.throwIfAborted()
        this.runtime.signal.throwIfAborted()
        const config = this.getConfig()
        const sandboxEnabled = config.sandbox.enabled
        const support = sandboxEnabled ? await getSandboxSupport() : undefined
        if (sandboxEnabled) {
          this.setState({
            sandbox: {
              active: false,
              support: support!,
              workspacePath: config.sandbox.workspacePath,
              networkAccess: config.sandbox.networkAccess,
              policyRevision: revision
            }
          })
          if (!support?.supported || !support.backend)
            throw new SandboxError(support?.reason || 'Sandboxing is unavailable on this device.')
          if (!this.supportsIPC)
            throw new SandboxError(
              'Update Open Terminal to a version supporting IPC before enabling the sandbox.'
            )
        }
        const host = config.httpEnabled ? config.httpHost : '127.0.0.1'
        const endpoint = await createTerminalEndpoint({
          ipc: this.supportsIPC,
          http: !sandboxEnabled && (config.httpEnabled || !this.supportsIPC),
          sandbox: sandboxEnabled,
          host
        })
        let sandbox: Awaited<ReturnType<typeof createSandboxPolicy>> | undefined
        try {
          if (sandboxEnabled)
            sandbox = await createSandboxPolicy({
              backend: support!.backend!,
              workspacePath: config.sandbox.workspacePath,
              networkAccess: config.sandbox.networkAccess,
              runtimePath: this.runtime.directory,
              socketPath: endpoint.socketPath!,
              forbiddenPaths: sandboxForbiddenPaths(),
              policyRevision: revision,
              signal
            })
          signal.throwIfAborted()
          if (revision !== this.policyRevision)
            throw new SandboxError('Sandbox settings changed during startup.')
        } catch (error) {
          await sandbox?.cleanup()
          await endpoint.cleanup()
          throw error
        }
        const key = randomBytes(48).toString('base64url')
        const httpUrl =
          endpoint.port === undefined ? undefined : 'http://127.0.0.1:' + endpoint.port
        const url = endpoint.socketPath ? 'http://127.0.0.1' : httpUrl!
        if (!this.supportsIPC)
          service.append(
            `Open Terminal ${this.state.version} does not support IPC; using authenticated HTTP on ${host}.\r\n`
          )
        const handle: TerminalHandle = {
          url,
          socketPath: endpoint.socketPath,
          httpUrl,
          cleanup: () => (sandbox ? sandbox.cleanup() : endpoint.cleanup()),
          key,
          capabilities: {},
          service,
          stop: () => service.stop(),
          sandbox: sandbox?.policy
        }
        this.handles.set(id, handle)
        return {
          file: this.runtime.executable,
          args: [
            ...(sandbox ? ['-I'] : []),
            '-m',
            'open_terminal',
            'run',
            '--isolated',
            ...(endpoint.socketPath ? ['--ipc', endpoint.socketPath] : []),
            ...(endpoint.port === undefined
              ? []
              : ['--port', String(endpoint.port), '--host', host]),
            '--cors-allowed-origins',
            ''
          ],
          cwd: sandbox?.policy.workspacePath || config.homeDirectory || homedir(),
          env: sandbox
            ? sandboxEnvironment(sandbox.policy, this.runtime.executable, config.env ?? {}, key)
            : Object.fromEntries(
                Object.entries({
                  ...this.environment(),
                  ...config.env,
                  OPEN_TERMINAL_ISOLATED: 'true',
                  OPEN_TERMINAL_API_KEY: key,
                  OPEN_TERMINAL_ENABLE_NOTEBOOKS: 'false',
                  OPEN_TERMINAL_MULTI_USER: 'false',
                  OPEN_TERMINAL_CORS_ALLOWED_ORIGINS: '',
                  OPEN_TERMINAL_LOG_DIR: join(app.getPath('logs'), 'terminal', id ?? 'local')
                }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              ),
          url: httpUrl,
          ready: (signal) =>
            waitForReady(
              async (signal) => {
                await readTerminalJSON(handle, '/files/cwd', key, signal)
                const discovery = (await readTerminalJSON(handle, '/api/config', key, signal)) as {
                  features?: Record<string, boolean>
                }
                handle.capabilities = { files: true, ...discovery.features }
                if (sandbox && (handle.capabilities.browser || handle.capabilities.desktop))
                  throw new SandboxError(
                    'Open Terminal did not disable browser and desktop access.'
                  )
                return true
              },
              signal,
              20000,
              200
            )
        }
      })
    } catch (error) {
      if (this.getConfig().sandbox.enabled) {
        const message = error instanceof Error ? error.message : String(error)
        const support = this.state.sandbox?.support ?? (await getSandboxSupport())
        this.setState({
          sandbox: {
            active: false,
            support,
            workspacePath: this.getConfig().sandbox.workspacePath,
            networkAccess: this.getConfig().sandbox.networkAccess,
            policyRevision: this.policyRevision,
            error: message
          }
        })
        throw new SandboxError(message)
      }
      throw error
    }
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
    await Promise.all(this.cleanups)
  }
}
