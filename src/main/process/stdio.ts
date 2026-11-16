import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

export interface StdioLaunch {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

// Includes processes still stopping, across every WebUI connection.
const active = new Set<StdioProcess>()

export async function stopStdioProcesses(): Promise<void> {
  await Promise.all([...active].map((process) => process.stop()))
}

export class StdioProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<void>
  private exited: Promise<void>
  private stopping?: Promise<void>

  constructor(launch: StdioLaunch) {
    if (active.size >= 16) throw new Error('Too many active MCP processes.')
    if (launch.cwd && !isAbsolute(launch.cwd))
      throw new Error('Choose an absolute working directory.')
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) =>
          value !== undefined &&
          /^(HOME|USERPROFILE|USER|LOGNAME|PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(
            name
          )
      )
    ) as Record<string, string>
    if (process.platform !== 'win32')
      env.PATH = [
        env.PATH ?? '',
        join(homedir(), '.local/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin'
      ].join(delimiter)
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd || homedir(),
      env: { ...env, ...launch.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    active.add(this)
    // Diagnostics must never enter the JSON-RPC stream or block the child.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => {})
    this.exited = new Promise((resolve) => {
      this.child.once('close', resolve)
      this.child.once('error', () => {
        if (!this.child.pid) resolve()
      })
    })
    this.ready = once(this.child, 'spawn').then(() => {})
    // Retire descendants even when the parent exits of its own accord.
    this.child.once('exit', () => {
      void this.stop().catch(() => {})
    })
    this.child.once('error', () => {
      void this.stop().catch(() => {})
    })
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      this.child.stdin.end()
      const wait = async (ms: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            this.exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), ms)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      await wait(1000)
      const pid = this.child.pid
      if (pid) {
        if (process.platform === 'win32') {
          if (this.child.exitCode === null && this.child.signalCode === null) {
            try {
              await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 3000
              })
            } catch (error) {
              if (this.child.exitCode === null && this.child.signalCode === null) throw error
            }
          }
        } else {
          for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            try {
              process.kill(-pid, signal)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
            if (signal === 'SIGTERM') await wait(1000)
          }
        }
      }
      if (!(await wait(2000))) throw new Error('MCP process did not exit.')
      active.delete(this)
    })()
    return this.stopping
  }
}
