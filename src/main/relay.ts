import { request as httpRequest, type ClientRequest } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import WebSocket from 'ws'
import type { Sessions } from './sessions'
import { endpoint, type Connection } from '../shared/connections'

const CHUNK = 64 * 1024
const WINDOW = 2 * 1024 * 1024
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

  constructor(
    private connection: Connection,
    private sessions: Sessions,
    private status: (message: string) => void,
    private getName: () => string,
    private notify: (payload: unknown) => void = () => {}
  ) {}

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
          name: this.getName()
        })
      )
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const access = await this.sessions.refresh(this.connection.id)
      if (!access || !this.sessions.credential(this.connection.id)?.sessionId || this.stopped)
        return
      const url = new URL(endpoint(this.connection.url, 'api/v1/tether/connect'))
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url, {
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
            notifications: true,
            token: access.token,
            connection_id: this.connection.id,
            name: this.getName(),
            services: [...this.destinations.keys()]
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
    }
  }

  private schedule(): void {
    this.connected = false
    this.notifications = false
    this.status('Local connection unavailable. Reconnecting.')
    clearTimeout(this.retry)
    this.retry = setTimeout(() => void this.connect(), this.delay)
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
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Relay disconnected')
    const packet = encode({ ...fields, type, stream: id, sequence: stream.outputSequence++ }, data)
    if (this.pendingSends >= 64) {
      socket.terminate()
      throw new Error('Relay send queue full')
    }
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
    }
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
      if (stream || this.streams.size >= 16 || header.sequence !== 0)
        throw new Error('Invalid stream')
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
    if (header.sequence !== stream.inputSequence++) throw new Error('Relay sequence gap')
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
    if (this.buffered > 32 * 1024 * 1024) throw new Error('Relay buffer limit exceeded')
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
    if (
      base.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username ||
      base.password
    )
      throw new Error('Invalid local destination')
    const url = new URL(header.path, base)
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
      const request = httpRequest(
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
            for await (const chunk of response) await this.chunks(header.stream, Buffer.from(chunk))
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
      url.protocol = 'ws:'
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
        if (queuedMessages >= 64 || this.queuedOutput + message.length > 32 * 1024 * 1024) {
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
