import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { once } from 'node:events'
import { connect } from 'node:net'
import WebSocket from 'ws'
import type { Sessions } from './sessions'
import { endpoint, type Connection } from '../shared/connections'
import { connectionSession, connectionTLS } from './network'
import { accessHeaders } from './access'
import type { UserConnection } from '../shared/userConnections'

const CHUNK = 64 * 1024
// ~40 MB/s per stream at 100 ms round trip. Buffers fill only while a reader falls behind.
const WINDOW = 4 * 1024 * 1024
const MAX_CONCURRENT_STREAMS = 64
// Streams × window: the most a fully stalled device could hold.
const BUFFER_BUDGET = MAX_CONCURRENT_STREAMS * WINDOW
// WebUIs that do not state a stream limit allow 16.
const DEFAULT_CONCURRENT_STREAMS = 16
const MAX_PENDING_SENDS = 256
const MAX_MESSAGE = 16 * 1024 * 1024

interface Packet {
  type: string
  stream: string
  sequence: number
  [key: string]: unknown
}

function encode(header: Packet, data: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header))
  if (json.length > 4096 || data.length > CHUNK) throw new Error('Relay packet too large')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  return Buffer.concat([length, json, data])
}

function decode(packet: Buffer): { header: Packet; data: Buffer } {
  if (packet.length < 4 || packet.length > CHUNK + 4100) throw new Error('Invalid relay packet')
  const length = packet.readUInt32BE()
  if (length > 4096 || length > packet.length - 4) throw new Error('Invalid relay header')
  const header = JSON.parse(packet.subarray(4, 4 + length).toString())
  if (
    !header ||
    typeof header.type !== 'string' ||
    typeof header.stream !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(header.stream) ||
    !Number.isSafeInteger(header.sequence) ||
    header.sequence < 0
  ) {
    throw new Error('Invalid relay header')
  }
  return { header, data: packet.subarray(4 + length) }
}

export interface RelayDestination {
  url: string
  // Replaces the requested path, e.g. to add the destination's base path. Must stay on `url`'s origin.
  path?: string
  socketPath?: string
  headers?: Record<string, string>
  firstMessage?: (data: Buffer, kind: string) => Buffer
}

type ResolveDestination = (path: string, websocket: boolean) => RelayDestination

interface Stream {
  service: string
  firstMessage?: RelayDestination['firstMessage']
  inputSequence: number
  outputSequence: number
  inputCredit: number
  outputCredit: number
  wake?: () => void
  closed: boolean
  request?: ClientRequest
  socket?: WebSocket
  chain: Promise<void>
  parts: Buffer[]
  size: number
}

export class Relay {
  connected = false
  notifications = false
  private socket?: WebSocket
  private window = 256 * 1024
  private output = Promise.resolve()
  private pendingSends = 0
  private streams = new Map<string, Stream>()
  private destinations = new Map<string, ResolveDestination>()
  private stopped = false
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private delay = 1000
  private buffered = 0
  private queuedOutput = 0
  private maxConcurrentStreams = DEFAULT_CONCURRENT_STREAMS
  private sendWaiters: (() => void)[] = []
  private connecting = false

  constructor(
    private connection: Connection,
    private sessions: Sessions,
    private status: (message: string) => void,
    private getName: () => string,
    private notify: (payload: unknown) => void = () => {},
    // The user's own connections, each also offered as a service of the same name.
    private getConnections: () => (Pick<UserConnection, 'name' | 'type'> & {
      service: string
    })[] = () => []
  ) {}

  serviceNames(): string[] {
    return [...this.destinations.keys()]
  }

  setService(name: string, resolve?: ResolveDestination): void {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error('Invalid service name')
    if (this.stopped) return
    if (resolve && !this.destinations.has(name) && this.destinations.size >= 16)
      throw new Error('Too many local services')
    for (const [id, stream] of this.streams) {
      if (stream.service === name) {
        void this.send(id, 'error', {
          message: 'Local service stopped; completion may be unknown.'
        }).catch(() => {})
        this.closeStream(id)
      }
    }
    if (resolve) this.destinations.set(name, resolve)
    else this.destinations.delete(name)
    this.updateName()
  }

  updateName(): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          type: 'services',
          services: [...this.destinations.keys()],
          connections: this.getConnections(),
          name: this.getName()
        })
      )
  }

  async connect(): Promise<void> {
    if (
      this.stopped ||
      this.connecting ||
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    )
      return
    this.connecting = true
    try {
      const access = await this.sessions.refresh(this.connection.id)
      if (!access || !this.sessions.credential(this.connection.id)?.sessionId || this.stopped)
        return
      const url = new URL(endpoint(this.connection.url, 'api/v1/tether/connect'))
      const headers = await accessHeaders(connectionSession(this.connection), url.href)
      if (this.stopped) return
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url, {
        ...connectionTLS(this.connection),
        headers,
        maxPayload: CHUNK + 4100,
        handshakeTimeout: 20000,
        followRedirects: false
      })
      this.socket = socket
      socket.on('error', () => {})
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            type: 'hello',
            version: 2,
            window: WINDOW,
            max_concurrent_streams: MAX_CONCURRENT_STREAMS,
            notifications: true,
            token: access.token,
            connection_id: this.connection.id,
            name: this.getName(),
            services: [...this.destinations.keys()],
            connections: this.getConnections()
          })
        )
      )
      socket.on('message', (bytes, binary) => {
        try {
          if (!binary) {
            const control = JSON.parse(bytes.toString())
            if (control.type === 'ready') {
              const window = control.window ?? 256 * 1024
              if (!Number.isSafeInteger(window) || window < CHUNK || window > WINDOW)
                throw new Error('Invalid relay window')
              this.window = window
              const streams = control.max_concurrent_streams
              this.maxConcurrentStreams =
                Number.isSafeInteger(streams) && streams >= 1
                  ? Math.min(streams, MAX_CONCURRENT_STREAMS)
                  : DEFAULT_CONCURRENT_STREAMS
              this.connected = true
              this.notifications = control.notifications === true
              this.delay = 1000
              this.status('')
            }
            return
          }
          const { header, data } = decode(Buffer.from(bytes as Buffer))
          if (header.type === 'notification') {
            if (this.notifications) this.notify(JSON.parse(data.toString()))
          } else this.receive(header, data)
        } catch {
          socket.close(1008, 'Invalid relay packet')
        }
      })
      let alive = true
      socket.on('pong', () => {
        alive = true
      })
      this.heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        if (socket.readyState === WebSocket.OPEN) socket.ping()
      }, 20000)
      socket.on('close', () => {
        clearInterval(this.heartbeat)
        for (const id of [...this.streams.keys()]) this.closeStream(id)
        if (!this.stopped) this.schedule()
      })
    } catch {
      if (!this.stopped) this.schedule()
    } finally {
      this.connecting = false
    }
  }

  // After sleep or a network change: confirm the socket is alive, or reconnect now instead of
  // waiting out the heartbeat and backoff.
  probe(): void {
    if (this.stopped) return
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.retry)
      this.delay = 1000
      void this.connect()
      return
    }
    if (socket.readyState !== WebSocket.OPEN) return
    let answered = false
    const pong = (): void => {
      answered = true
    }
    socket.once('pong', pong)
    socket.ping()
    setTimeout(() => {
      socket.off('pong', pong)
      if (!answered && this.socket === socket && socket.readyState === WebSocket.OPEN) {
        this.delay = 1000
        socket.terminate()
      }
    }, 5000)
  }

  private schedule(): void {
    this.connected = false
    this.notifications = false
    this.status('Local connection unavailable. Reconnecting.')
    clearTimeout(this.retry)
    // Jitter keeps devices from reconnecting in lockstep after a WebUI restart.
    this.retry = setTimeout(() => void this.connect(), this.delay * (0.5 + Math.random()))
    this.delay = Math.min(30000, this.delay * 2)
  }

  updateToken(token: string): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'auth', token }))
  }

  private async send(
    id: string,
    type: string,
    fields: Record<string, unknown> = {},
    data: Buffer = Buffer.alloc(0)
  ): Promise<void> {
    const stream = this.streams.get(id)
    if (!stream || stream.closed) throw new Error('Stream closed')
    if (data.length) {
      while (stream.outputCredit < data.length && !stream.closed)
        await new Promise<void>((resolve) => {
          stream.wake = resolve
        })
      if (stream.closed) throw new Error('Stream closed')
      stream.outputCredit -= data.length
    }
    // Wait for a slot instead of dropping every stream when many are sending at once.
    if (this.pendingSends >= MAX_PENDING_SENDS || this.sendWaiters.length)
      await new Promise<void>((resolve) => this.sendWaiters.push(resolve))
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.sendWaiters.shift()?.()
      throw new Error('Relay disconnected')
    }
    // Numbered only once queued, so sequence order always matches send order.
    const packet = encode({ ...fields, type, stream: id, sequence: stream.outputSequence++ }, data)
    this.pendingSends++
    // Each producer awaits one chunk; a shared FIFO gives other streams a turn.
    const sent = this.output.then(async () => {
      await new Promise<void>((resolve, reject) =>
        socket.send(packet, (error) => (error ? reject(error) : resolve()))
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
    })
    this.output = sent.catch(() => {})
    try {
      await sent
    } finally {
      this.pendingSends--
      this.sendWaiters.shift()?.()
    }
  }

  // The WebUI accepts an error at sequence 0 for any stream it opened.
  private reject(id: string, message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(encode({ type: 'error', stream: id, sequence: 0, message }))
  }

  private async chunks(id: string, data: Buffer, kind?: string): Promise<void> {
    for (let offset = 0; offset < data.length || offset === 0; offset += CHUNK) {
      const chunk = data.subarray(offset, offset + CHUNK)
      await this.send(id, 'data', { kind, final: offset + CHUNK >= data.length }, chunk)
    }
  }

  private receive(header: Packet, data: Buffer): void {
    let stream = this.streams.get(header.stream)
    if (header.type === 'http-open' || header.type === 'ws-open') {
      if (stream || header.sequence !== 0) throw new Error('Invalid stream')
      // A full device refuses this one operation; the other streams keep running.
      if (this.streams.size >= this.maxConcurrentStreams) {
        this.reject(header.stream, 'Tether has too many active operations.')
        return
      }
      stream = {
        service: typeof header.service === 'string' ? header.service : '',
        inputSequence: 0,
        outputSequence: 0,
        inputCredit: this.window,
        outputCredit: this.window,
        closed: false,
        chain: Promise.resolve(),
        parts: [],
        size: 0
      }
      this.streams.set(header.stream, stream)
    }
    if (!stream) return // A cancellation may race buffered replies.
    if (header.sequence !== stream.inputSequence++) {
      // Fail only the stream whose frames went missing.
      void this.send(header.stream, 'error', { message: 'Relay sequence gap' }).catch(() => {})
      this.closeStream(header.stream)
      return
    }
    if (header.type === 'window') {
      const credit = Number(header.bytes)
      if (
        !Number.isSafeInteger(credit) ||
        credit <= 0 ||
        stream.outputCredit + credit > this.window
      )
        throw new Error('Invalid window')
      stream.outputCredit += credit
      stream.wake?.()
      return
    }
    if (header.type === 'cancel') {
      this.closeStream(header.stream)
      return
    }
    if (data.length > stream.inputCredit) throw new Error('Receive window exceeded')
    stream.inputCredit -= data.length
    this.buffered += data.length
    if (this.buffered > BUFFER_BUDGET) throw new Error('Relay buffer limit exceeded')
    const current = stream
    current.chain = current.chain
      .then(async () => {
        if (current.closed) return
        if (header.type === 'http-open' || header.type === 'ws-open')
          await this.open(header, current)
        else if (header.type === 'data') {
          if (current.request) {
            if (!current.request.write(data)) await once(current.request, 'drain')
          } else if (current.socket) {
            current.parts.push(data)
            current.size += data.length
            if (current.size > MAX_MESSAGE) throw new Error('Local message too large')
            if (header.final) {
              let message: Buffer = Buffer.concat(current.parts)
              current.parts = []
              current.size = 0
              if (current.firstMessage) {
                message = current.firstMessage(message, String(header.kind))
                current.firstMessage = undefined
              }
              await new Promise<void>((resolve, reject) =>
                current.socket!.send(message, { binary: header.kind !== 'text' }, (error) =>
                  error ? reject(error) : resolve()
                )
              )
            }
          }
        } else if (header.type === 'end') {
          if (current.request) current.request.end()
          else this.closeStream(header.stream)
        } else throw new Error('Unknown relay operation')
        if (data.length && !current.closed) {
          current.inputCredit += data.length
          await this.send(header.stream, 'window', { bytes: data.length })
        }
      })
      .catch(async () => {
        await this.send(header.stream, 'error', {
          message: 'Local operation interrupted; completion may be unknown.'
        }).catch(() => {})
        this.closeStream(header.stream)
      })
      .finally(() => {
        this.buffered -= data.length
      })
  }

  private async open(header: Packet, stream: Stream): Promise<void> {
    if (
      typeof header.path !== 'string' ||
      !header.path.startsWith('/') ||
      header.path.startsWith('//') ||
      header.path.includes('\\')
    )
      throw new Error('Invalid local path')
    const resolve = this.destinations.get(stream.service)
    if (!resolve) throw new Error('Local service unavailable')
    const destination = resolve(header.path, header.type === 'ws-open')
    const base = new URL(destination.url)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('Invalid local destination')
    const url = new URL(destination.path ?? header.path, base)
    if (url.origin !== base.origin) throw new Error('Forbidden local path')
    stream.firstMessage = destination.firstMessage
    if (typeof header.query === 'string' && header.query) url.search = header.query
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((header.headers ?? {}) as Record<string, unknown>)) {
      if (
        typeof value === 'string' &&
        !/^(authorization|cookie|host|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-websocket-.*)$/i.test(
          key
        )
      )
        headers[key] = value
    }
    Object.assign(headers, destination.headers)
    if (header.type === 'http-open') {
      const method = String(header.method).toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method))
        throw new Error('Invalid method')
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        { method, headers, socketPath: destination.socketPath, agent: false },
        (response) => {
          void (async () => {
            const responseHeaders = Object.fromEntries(
              Object.entries(response.headers).filter(
                ([key]) => !/^(set-cookie|connection|transfer-encoding)$/i.test(key)
              )
            )
            await this.send(header.stream, 'http-response', {
              status: response.statusCode,
              headers: responseHeaders
            })
            for await (const chunk of response) {
              // Send what arrived while the last chunk waited for credit as one frame, so token
              // streams don't flood the WebUI with tiny frames. chunks() splits anything over 64 KB.
              const rest = response.read() as Buffer | null
              await this.chunks(
                header.stream,
                rest ? Buffer.concat([chunk, rest]) : Buffer.from(chunk)
              )
            }
            await this.send(header.stream, 'end')
            this.closeStream(header.stream)
          })().catch(async () => {
            await this.send(header.stream, 'error', {
              message: 'Local response interrupted.'
            }).catch(() => {})
            this.closeStream(header.stream)
          })
        }
      )
      stream.request = request
      request.on('error', () => {
        void this.send(header.stream, 'error', { message: 'Local request failed.' })
          .catch(() => {})
          .finally(() => this.closeStream(header.stream))
      })
      request.setTimeout(300000, () => request.destroy(new Error('Local request timed out')))
    } else {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url, {
        ...(destination.socketPath
          ? { createConnection: () => connect(destination.socketPath!) }
          : {}),
        headers,
        maxPayload: MAX_MESSAGE,
        handshakeTimeout: 10000,
        followRedirects: false
      })
      stream.socket = socket
      socket.on('error', () => {})
      const ready = once(socket, 'open').then(() => this.send(header.stream, 'ws-ready'))
      // Servers can send their initial state with the upgrade response.
      let output = ready
      let queuedMessages = 0
      socket.on('message', (data, binary) => {
        if (stream.closed) return
        socket.pause()
        const message = Buffer.from(data as Buffer)
        if (queuedMessages >= 64 || this.queuedOutput + message.length > BUFFER_BUDGET) {
          void this.send(header.stream, 'error', {
            message: 'Local output backlog exceeded.'
          }).catch(() => {})
          this.closeStream(header.stream)
          return
        }
        queuedMessages++
        this.queuedOutput += message.length
        output = output
          .then(() => this.chunks(header.stream, message, binary ? 'binary' : 'text'))
          .then(() => socket.resume())
          .catch(() => this.closeStream(header.stream))
          .finally(() => {
            queuedMessages--
            this.queuedOutput -= message.length
          })
      })
      socket.on('close', (code) => {
        void output
          .then(() => this.send(header.stream, 'end', { code }))
          .catch(() => {})
          .finally(() => this.closeStream(header.stream))
      })
      await ready
    }
  }

  private closeStream(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) return
    stream.closed = true
    stream.wake?.()
    stream.request?.destroy()
    stream.socket?.terminate()
    this.streams.delete(id)
  }

  stop(): void {
    this.connected = false
    this.notifications = false
    this.stopped = true
    clearTimeout(this.retry)
    clearInterval(this.heartbeat)
    for (const id of [...this.streams.keys()]) this.closeStream(id)
    this.socket?.close(1000)
  }
}
