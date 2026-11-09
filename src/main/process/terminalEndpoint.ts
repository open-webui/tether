import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createTerminalEndpoint({
  ipc,
  http,
  host,
  sandbox = false
}: {
  ipc: boolean
  http: boolean
  host: string
  sandbox?: boolean
}): Promise<{
  socketPath: string | undefined
  port: number | undefined
  cleanup(): Promise<void>
}> {
  if (sandbox && (!ipc || http))
    throw new Error('Sandboxed terminals require IPC with HTTP disabled.')
  // Keep the Unix socket name short enough for macOS's 104-byte limit.
  const directory =
    !ipc || process.platform === 'win32'
      ? undefined
      : await realpath(await mkdtemp(join(tmpdir(), 'tt-')))
  const socketPath = !ipc
    ? undefined
    : directory
      ? join(directory, 'api')
      : '\\\\.\\pipe\\' + (sandbox ? 'LOCAL\\' : '') + 'tether-' + randomUUID()
  const cleanup = (): Promise<void> =>
    directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()
  try {
    const port = http
      ? await new Promise<number>((resolve, reject) => {
          const server = createServer()
          server.once('error', reject)
          server.listen(0, host, () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
              server.close()
              reject(new Error('No local port available'))
              return
            }
            server.close((error) => (error ? reject(error) : resolve(address.port)))
          })
        })
      : undefined
    return { socketPath, port, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function readTerminalJSON(
  destination: { url: string; socketPath?: string },
  path: string,
  key: string,
  signal: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, destination.url),
      {
        socketPath: destination.socketPath,
        headers: { Authorization: 'Bearer ' + key },
        signal,
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('error', reject)
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 1024 * 1024) res.destroy(new Error('Terminal response too large'))
          else chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('Terminal is not ready')
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}
