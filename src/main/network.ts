import { net } from 'electron'
import { addAbortSignal, Readable } from 'node:stream'

// net.fetch rejects manual redirects; validation needs their status and location.
export function fetchConnection(url: string, { signal }: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const request = net.request({ url, redirect: 'manual', credentials: 'omit' })
    const abort = (): void => {
      reject(signal?.reason)
      request.abort()
    }
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = (): void => signal?.removeEventListener('abort', abort)
    request.once('error', cleanup)
    request.once('redirect', cleanup)
    request.once('response', cleanup)
    request.on('error', reject)
    request.on('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }))
      request.abort()
    })
    request.on('response', (response) => {
      try {
        const body = response as unknown as Readable
        if (signal) addAbortSignal(signal, body)
        response.on('aborted', () => body.destroy(new Error('WebUI response was interrupted.')))
        resolve(
          new Response(
            [204, 205, 304].includes(response.statusCode)
              ? null
              : (Readable.toWeb(body) as ReadableStream),
            { status: response.statusCode }
          )
        )
      } catch (error) {
        reject(error)
        request.abort()
      }
    })
    request.end()
  })
}
