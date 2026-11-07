import { app, dialog, net, session, type Session } from 'electron'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { checkServerIdentity, type ConnectionOptions } from 'node:tls'
import { addAbortSignal, Readable } from 'node:stream'
import { normalizeURL, validateConnectionURL, type Connection } from '../shared/connections'

function validCertificate(certificate: X509Certificate, hostname: string): boolean {
  return (
    Date.parse(certificate.validFrom) <= Date.now() &&
    Date.now() <= Date.parse(certificate.validTo) &&
    !checkServerIdentity(hostname, certificate.toLegacyObject())
  )
}

function configureTrust(
  profile: Session,
  connection: Connection,
  rejected?: (certificate: X509Certificate, error: number) => void
): void {
  const hostname = new URL(connection.url).hostname.replace(/^\[|\]$/g, '')
  const trusted = connection.trustedCertificate
    ? new X509Certificate(connection.trustedCertificate).fingerprint256
    : undefined
  profile.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== hostname) return callback(-3)
    const certificate = new X509Certificate(request.certificate.data)
    if (
      trusted === certificate.fingerprint256 &&
      [0, -202].includes(request.errorCode) &&
      validCertificate(certificate, hostname)
    )
      return callback(0)
    if (trusted || request.errorCode !== 0) {
      rejected?.(certificate, request.errorCode)
      return callback(trusted ? -207 : -3)
    }
    callback(-3)
  })
}

const configured = new WeakSet<Session>()

export function connectionSession(connection: Connection): Session {
  // A different trust policy needs a fresh profile: Chromium caches certificate decisions.
  const suffix = connection.trustedCertificate
    ? '-' +
      createHash('sha256')
        .update(connection.url + connection.trustedCertificate)
        .digest('hex')
    : ''
  const profile = session.fromPath(
    join(app.getPath('userData'), 'profiles', connection.id + suffix)
  )
  if (connection.trustedCertificate && !configured.has(profile)) {
    configureTrust(profile, connection)
    configured.add(profile)
  }
  return profile
}

export function connectionTLS(connection: Connection): ConnectionOptions {
  if (!connection.trustedCertificate) return {}
  const trusted = new X509Certificate(connection.trustedCertificate).fingerprint256
  return {
    ca: connection.trustedCertificate,
    allowPartialTrustChain: true,
    checkServerIdentity: (hostname, certificate) =>
      checkServerIdentity(hostname, certificate) ??
      (certificate.fingerprint256 === trusted
        ? undefined
        : new Error('WebUI certificate changed. Edit the connection to trust it again.'))
  }
}

export async function validateConnection(connection: Connection): Promise<Connection> {
  const candidate = { ...connection, url: normalizeURL(connection.url.trim()) }
  // Probe without cookies, and use a fresh verifier after approval (Chromium caches verdicts).
  for (let attempt = 0; attempt < 2; attempt++) {
    const profile = session.fromPartition('validate-' + randomUUID(), { cache: false })
    let rejected: { certificate: X509Certificate; error: number } | undefined
    configureTrust(profile, candidate, (certificate, error) => {
      rejected = { certificate, error }
    })
    try {
      await validateConnectionURL(candidate.url, (url, options) =>
        fetchConnection(url, options, profile)
      )
      return candidate
    } catch (error) {
      if (!rejected) throw error
      const { certificate, error: verification } = rejected
      const hostname = new URL(candidate.url).hostname.replace(/^\[|\]$/g, '')
      if (attempt || ![0, -202].includes(verification) || !validCertificate(certificate, hostname))
        throw new Error('WebUI certificate is invalid or changed. Check its hostname and expiry.')
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: candidate.trustedCertificate
          ? 'WebUI certificate changed. Trust the new certificate?'
          : 'Trust this WebUI certificate?',
        detail: `${candidate.url}\n\nOnly continue if you recognize this server and have verified its certificate.\n\nSHA-256: ${certificate.fingerprint256}\nExpires: ${certificate.validTo}\n\nTrust applies only to this connection.`,
        buttons: ['Cancel', 'Trust Certificate'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (response !== 1) throw new Error('WebUI certificate was not trusted.')
      candidate.trustedCertificate = certificate.toString()
    } finally {
      await profile.closeAllConnections()
    }
  }
  throw new Error('WebUI certificate changed while connecting. Try again.')
}

// net.fetch rejects manual redirects; validation needs their status and location.
export function fetchConnection(
  url: string,
  { signal }: RequestInit,
  profile: Session
): Promise<Response> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const request = net.request({ url, session: profile, redirect: 'manual', credentials: 'omit' })
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
