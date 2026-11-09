import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm, statfs } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import type { SandboxBackend } from '../../shared/sandbox'
import { isSandboxEnvironmentVariable } from '../../shared/sandbox'
import { seatbeltLaunch } from './seatbelt'

export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

export interface SandboxPolicy {
  backend: SandboxBackend
  workspacePath: string
  runtimePath: string
  sessionPath: string
  socketPath: string
  policyRevision: number
  workspaceIdentity: { dev: number; ino: number }
}

export function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}

export async function validateWorkspace(
  path: string,
  forbiddenPaths: string[],
  signal: AbortSignal = new AbortController().signal
): Promise<string> {
  signal.throwIfAborted()
  if (
    !isAbsolute(path) ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    path.startsWith('\\\\')
  )
    throw new SandboxError('Choose an absolute path on a local filesystem.')
  let workspace: string
  try {
    workspace = await realpath(path)
  } catch {
    throw new SandboxError('The workspace folder does not exist or is inaccessible.')
  }
  const root = await lstat(workspace)
  if (!root.isDirectory() || workspace === parse(workspace).root)
    throw new SandboxError('Choose a workspace folder, not a filesystem root.')
  if (process.platform === 'win32') {
    if (!/^[a-z]:\\/i.test(workspace)) throw new SandboxError('Choose a local NTFS workspace.')
    const drive = workspace.slice(0, 3)
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const { stdout } = await promisify(execFile)(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$d = [System.IO.DriveInfo]::new('${drive}'); if ($d.DriveType -eq 'Fixed' -and $d.DriveFormat -eq 'NTFS') { 'supported' }`
      ],
      { windowsHide: true, timeout: 5000, signal }
    )
    if (stdout.trim() !== 'supported')
      throw new SandboxError('Choose a folder on a local NTFS disk.')
  }
  for (const entry of [homedir(), tmpdir(), ...forbiddenPaths]) {
    const protectedPath = await realpath(entry).catch(() => entry)
    if (
      containsPath(workspace, protectedPath) ||
      (forbiddenPaths.includes(entry) && containsPath(protectedPath, workspace))
    )
      throw new SandboxError('Choose a folder separate from your home root and Tether files.')
  }
  await access(workspace, constants.R_OK | constants.W_OK | constants.X_OK)
  if (process.platform !== 'win32') {
    const filesystem = await statfs(workspace)
    // Only known local filesystems; unknown/network filesystems fail closed.
    const local =
      process.platform === 'darwin'
        ? [0x1a, 0x11]
        : [0xef53, 0x58465342, 0x9123683e, 0x1021994, 0x794c7630]
    if (!local.includes(filesystem.type >>> 0))
      throw new SandboxError('This workspace filesystem is not supported. Choose a local disk.')
  }
  const pending = [workspace]
  while (pending.length) {
    signal.throwIfAborted()
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      const child = join(directory, entry.name)
      const info = await lstat(child)
      if (info.dev !== root.dev)
        throw new SandboxError('The workspace must not contain mounted filesystems.')
      if (info.isSymbolicLink()) {
        const target = await realpath(child).catch(() => '')
        if (!target || !containsPath(workspace, target))
          throw new SandboxError(
            'The workspace contains a link outside the folder or a broken link.'
          )
      } else if (info.isFile() && info.nlink > 1) {
        throw new SandboxError('The workspace contains hard-linked files. Use independent copies.')
      } else if (info.isDirectory()) pending.push(child)
      else if (!info.isFile())
        throw new SandboxError(
          'The workspace contains a socket, device, or other unsupported file.'
        )
    }
  }
  return workspace
}

export async function createSandboxPolicy(input: {
  backend: SandboxBackend
  workspacePath: string
  runtimePath: string
  socketPath: string
  policyRevision: number
  forbiddenPaths: string[]
  signal: AbortSignal
}): Promise<{ policy: SandboxPolicy; cleanup(): Promise<void> }> {
  const workspacePath = await validateWorkspace(
    input.workspacePath,
    input.forbiddenPaths,
    input.signal
  )
  const runtimePath = await realpath(input.runtimePath)
  const info = await lstat(workspacePath)
  const sessionPath = await realpath(await mkdtemp(join(tmpdir(), 'tether-sandbox-')))
  const policy: SandboxPolicy = {
    backend: input.backend,
    workspacePath,
    runtimePath,
    sessionPath,
    socketPath: input.socketPath,
    policyRevision: input.policyRevision,
    workspaceIdentity: { dev: info.dev, ino: info.ino }
  }
  const cleanup = async (): Promise<void> => {
    const paths = [
      sessionPath,
      ...(process.platform === 'win32' ? [] : [dirname(input.socketPath)])
    ]
    if (process.platform === 'darwin') {
      // A detached descendant must not turn a cleanup symlink race into host file access.
      const command = seatbeltLaunch(
        {
          file: '/bin/rm',
          args: ['-rf', '--', ...paths],
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' }
        },
        policy
      )
      await promisify(execFile)(command.file, command.args, {
        cwd: '/',
        env: command.env,
        timeout: 10000
      })
    } else {
      for (const path of paths) await rm(path, { recursive: true, force: true })
    }
  }
  try {
    for (const name of ['home', 'tmp', 'cache', 'logs'])
      await mkdir(join(sessionPath, name), { mode: 0o700 })
    input.signal.throwIfAborted()
    return {
      policy,
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function verifyWorkspace(policy: SandboxPolicy): Promise<void> {
  const info = await lstat(policy.workspacePath)
  if (
    info.isSymbolicLink() ||
    info.dev !== policy.workspaceIdentity.dev ||
    info.ino !== policy.workspaceIdentity.ino
  )
    throw new SandboxError('The workspace changed during startup. Select it again.')
}

export function sandboxEnvironment(
  policy: SandboxPolicy,
  executable: string,
  custom: Record<string, string>,
  apiKey: string
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(custom)) {
    if (isSandboxEnvironmentVariable(name))
      throw new SandboxError(`${name} is managed by Tether while the sandbox is enabled.`)
    if (!/^OPEN_TERMINAL_(BROWSER_|ENABLE_BROWSER$|ENABLE_DESKTOP$|FILE_BROWSER_ROOT$)/i.test(name))
      env[name] = value
  }
  const home = join(policy.sessionPath, 'home')
  const temp = join(policy.sessionPath, 'tmp')
  Object.assign(env, {
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: join(policy.sessionPath, 'cache'),
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    PATH: [
      dirname(executable),
      ...(process.platform === 'win32'
        ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
        : ['/usr/bin', '/bin'])
    ].join(delimiter),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONSAFEPATH: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INDEX: '1',
    OPEN_TERMINAL_ISOLATED: 'true',
    OPEN_TERMINAL_API_KEY: apiKey,
    OPEN_TERMINAL_ENABLE_BROWSER: 'false',
    OPEN_TERMINAL_ENABLE_DESKTOP: 'false',
    OPEN_TERMINAL_ENABLE_NOTEBOOKS: 'false',
    OPEN_TERMINAL_MULTI_USER: 'false',
    OPEN_TERMINAL_CORS_ALLOWED_ORIGINS: '',
    OPEN_TERMINAL_FILE_BROWSER_ROOT: policy.workspacePath,
    OPEN_TERMINAL_LOG_DIR: join(policy.sessionPath, 'logs')
  })
  if (process.platform === 'win32')
    Object.assign(env, {
      SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows',
      WINDIR: process.env.SystemRoot || 'C:\\Windows',
      COMSPEC: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      USERPROFILE: home,
      LOCALAPPDATA: home,
      APPDATA: home,
      PATHEXT: '.COM;.EXE;.BAT;.CMD'
    })
  else env.SHELL = '/bin/sh'
  return env
}
