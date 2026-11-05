// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { lookup as dnsLookup } from 'node:dns'
import { addAbortListener } from 'node:events'
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import https from 'node:https'
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { pipeline, Transform, type Readable } from 'node:stream'
import { classifyAddress, parseCidr, type Net } from './cidr'
import { trustedCa } from './pem'

/**
 * Phase 3d-3b spec §3: the one HTTP client destinations use. The address is judged inside the
 * socket's own DNS lookup, so what is checked is what is connected to (DNS rebinding); literal IPs
 * are judged before the request. HTTPS only (http inside the listed networks), no redirects, no
 * proxies, bounded headers, bodies and idle time.
 */
export type EgressReason =
  | 'address_refused'
  /** Reserved, metadata or link-local: no setting can ever allow it. */
  | 'address_never'
  | 'http_refused'
  | 'bad_url'
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'redirect'
  | 'too_large'
  | 'network'
  | 'aborted'
  /** W4.5: the proxy refused, could not be reached, or answered something else than a tunnel. */
  | 'proxy'
  /** Review of the stream errors (2026-10-20): the request's own body could not be read. */
  | 'body'

export class EgressError extends Error {
  override name = 'EgressError'
  /** A redirect's whole target (see the constructor). */
  declare readonly location?: string
  constructor(
    readonly reason: EgressReason,
    message: string,
    readonly detail?: string,
    location?: string,
  ) {
    super(message)
    // A redirect's whole target, for a caller that follows its own allowed hosts: not enumerable,
    // so no logger prints it — it may carry a signed query (review 2026-10-11).
    Object.defineProperty(this, 'location', { value: location, enumerable: false })
  }
}

export interface EgressRequest {
  method: string
  url: string | URL
  headers?: Record<string, string>
  body?: Buffer | Readable
  caPem?: string
  signal?: AbortSignal
  /**
   * Phase 3d-3b final review: the whole exchange (headers and body) must end within this time. For
   * small, bounded answers — a trickle of one byte a minute never trips the idle timer.
   */
  deadlineMs?: number
  /**
   * Phase 4a-1 plan ruling 1: every address must be inside the listed networks (a connection that
   * allows local AI providers only), judged where the socket connects.
   */
  privateOnly?: boolean
}
export interface EgressResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
  /** The address the request connected to (phase 4a-1: local or cloud); absent from test stubs. */
  remoteAddress?: string | null
}
export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>
export interface Egress {
  request(r: EgressRequest): Promise<EgressResponse>
  buffer(
    r: EgressRequest,
    limit?: number,
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>
  probe(
    url: string | URL,
    caPem?: string,
    signal?: AbortSignal,
  ): Promise<{ resolveMs: number; connectMs: number }>
  /** The address is inside the listed networks. */
  listed(address: string): boolean
  /**
   * W3.3, W4.5: a plain TCP socket (the SMTP channel, an SFTP destination's SSH session), judged like
   * a request: the name resolved and every address judged before dialling, then the judged address
   * dialled (what is checked is what is connected to); connected within the connect timeout. Fakes
   * may leave it out.
   */
  socket?(r: SocketRequest): Promise<Socket>
}

export interface SocketRequest {
  host: string
  port: number
  signal?: AbortSignal
  /**
   * W4.5: an address outside the listed networks is reached through the egress's proxy (CONNECT to
   * the judged address), when the egress has one. Only backup destinations ask for it; the alert
   * channels' egress has no proxy at all (MM_BACKUP_PROXY is the backups' setting).
   */
  viaProxy?: boolean
  /** W4.5: how long the name took to resolve and the socket to connect (a destination's test). */
  onTiming?: (t: { address: string; resolveMs: number; connectMs: number }) => void
}

/** An egress whose sockets are there (createEgress's). */
export type SocketEgress = Egress & { socket(r: SocketRequest): Promise<Socket> }

export const JSON_LIMIT = 1024 * 1024
/** Phase 3d-3b final review: the overall deadline of a small answer (listings, manifests, ListParts). */
export const SMALL_ANSWER_MS = 5 * 60_000
/** An answer a provider may legitimately take long to give (S3 completion, a Nextcloud assembly). */
export const SLOW_ANSWER_MS = 30 * 60_000
const CONNECT_MS = 10_000
const IDLE_MS = 60_000
const HEADER_BYTES = 16 * 1024

const systemLookup: LookupFn = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (e, list) => (e ? reject(e) : resolve(list))),
  )

const TLS_CODES = /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_OSSL)/

function mapError(e: unknown): EgressError {
  if (e instanceof EgressError) return e
  const err = e as NodeJS.ErrnoException
  const code = String(err?.code ?? '')
  if (err?.name === 'AbortError' || code === 'ABORT_ERR')
    return new EgressError('aborted', 'The request was stopped')
  if (TLS_CODES.test(code))
    return new EgressError('tls', 'The destination’s certificate is not trusted', code)
  if (code === 'HPE_HEADER_OVERFLOW')
    return new EgressError('too_large', 'The destination sent too large an answer')
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
    return new EgressError('connect', 'The destination cannot be reached', code)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return new EgressError('dns', 'The destination’s name does not resolve', code)
  return new EgressError('network', 'The connection to the destination failed', code || undefined)
}

interface ProxySettings {
  host: string
  port: number
  secure: boolean
  /** "Basic …" from the credentials in the proxy's address; never logged or put in an error. */
  authorization: string | null
}

/** W4.5: MM_BACKUP_PROXY as the egress uses it (the configuration checked its shape already). */
function parseProxy(text: string): ProxySettings {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new EgressError('proxy', 'The proxy setting is not a valid address')
  }
  const secure = url.protocol === 'https:'
  if (!secure && url.protocol !== 'http:')
    throw new EgressError('proxy', 'The proxy must be http:// or https://')
  const user = decodeURIComponent(url.username)
  const pass = decodeURIComponent(url.password)
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (secure ? 443 : 80)),
    secure,
    authorization: user || pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : null,
  }
}

/**
 * W4.5: reads a proxy's answer to CONNECT — at most HEADER_BYTES, within `ms`; anything but a 2xx is
 * the proxy's refusal (its own words are not kept: they could echo the credentials).
 */
function connectReply(socket: Socket, ms: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0)
    const done = (e: EgressError | null, rest?: Buffer) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (e) {
        socket.destroy()
        reject(e)
      } else resolve(rest!)
    }
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk])
      const end = got.indexOf('\r\n\r\n')
      if (end < 0) {
        if (got.length > HEADER_BYTES) done(new EgressError('proxy', 'The proxy sent too large an answer'))
        return
      }
      if (end > HEADER_BYTES) return done(new EgressError('proxy', 'The proxy sent too large an answer'))
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(got.subarray(0, Math.min(end, 64)).toString('latin1'))
      const code = status ? Number(status[1]) : 0
      if (code === 407) return done(new EgressError('proxy', 'The proxy refused the credentials', '407'))
      if (code < 200 || code > 299)
        return done(
          new EgressError('proxy', 'The proxy refused the connection', code ? String(code) : undefined),
        )
      done(null, got.subarray(end + 4))
    }
    const onError = (e: Error) =>
      done(new EgressError('proxy', 'The proxy cannot be reached', (e as NodeJS.ErrnoException).code))
    const onClose = () => done(new EgressError('proxy', 'The proxy closed the connection'))
    const timer = setTimeout(() => done(new EgressError('proxy', 'The proxy did not answer in time')), ms)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

export function createEgress(opts: {
  networks: readonly string[]
  lookup?: LookupFn
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  /** The default overall deadline of buffer() (SMALL_ANSWER_MS). */
  smallDeadlineMs?: number
  /** The setting named when an address or plain http is refused. */
  networksSetting?: string
  /**
   * W4.5: an HTTP(S) proxy for https targets outside the listed networks. The target is still
   * resolved and judged here; the proxy is asked to CONNECT to that address, never to a name.
   */
  proxy?: string
}): SocketEgress {
  const allowed: Net[] = opts.networks.map(parseCidr)
  const resolveAll = opts.lookup ?? systemLookup
  const connectMs = opts.connectTimeoutMs ?? CONNECT_MS
  const idleMs = opts.idleTimeoutMs ?? IDLE_MS
  const smallDeadlineMs = opts.smallDeadlineMs ?? SMALL_ANSWER_MS
  const setting = opts.networksSetting ?? 'MM_BACKUP_PRIVATE_NETWORKS'
  const proxy = opts.proxy ? parseProxy(opts.proxy) : null

  /** Judges a resolved list: every address must pass; http needs every one inside the listed networks. */
  function judge(list: Array<{ address: string }>, plainHttp: boolean, privateOnly = false): void {
    if (!list.length) throw new EgressError('dns', 'The destination’s name does not resolve')
    for (const a of list) {
      const v = classifyAddress(a.address, allowed)
      if (!v.ok)
        throw new EgressError(
          // Final gate: only a private or loopback address can be listed by the operator.
          v.reason === 'private' || v.reason === 'loopback' ? 'address_refused' : 'address_never',
          `The destination’s address is not allowed (${v.reason})`,
        )
      if (privateOnly && !v.allowedNetwork)
        throw new EgressError('address_refused', `The destination is not on a network listed in ${setting}`)
      if (plainHttp && !v.allowedNetwork)
        throw new EgressError('http_refused', `Plain http is allowed only inside ${setting}`)
    }
  }

  function parse(u: string | URL): { url: URL; host: string; literal: boolean } {
    let url: URL
    try {
      url = new URL(String(u))
    } catch {
      throw new EgressError('bad_url', 'The destination’s address is not valid')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new EgressError('bad_url', 'Only https:// addresses are allowed')
    if (url.username || url.password)
      throw new EgressError('bad_url', 'Credentials do not belong in the address')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return { url, host, literal: isIP(host) !== 0 }
  }

  const guardedLookup =
    (plainHttp: boolean, privateOnly: boolean): LookupFunction =>
    (hostname, options, callback) => {
      resolveAll(hostname).then(
        (list) => {
          try {
            judge(list, plainHttp, privateOnly)
          } catch (e) {
            return callback(e as Error, '', 0)
          }
          if ((options as { all?: boolean }).all)
            (callback as unknown as (e: null, l: typeof list) => void)(null, list)
          else callback(null, list[0]!.address, list[0]!.family)
        },
        (e) => callback(mapError(e), '', 0),
      )
    }

  /**
   * W4.5: the TLS socket of an https request when a proxy is set. The target's addresses are judged
   * here, as the guarded lookup judges them; a target wholly inside the listed networks is reached
   * directly, any other through a CONNECT to its judged addresses in turn (the proxy resolves nothing,
   * so it cannot be steered elsewhere by DNS). TLS runs end to end, checked against the target's name
   * — or, for an IP-address target, against that address (W4 review I1: never "localhost").
   */
  async function tlsSocket(
    p: ProxySettings,
    target: { host: string; port: number; literal: boolean },
    r: EgressRequest,
  ): Promise<TLSSocket> {
    const list = target.literal
      ? [{ address: target.host, family: isIP(target.host) }]
      : await resolveAll(target.host).catch((e) => Promise.reject(mapError(e)))
    judge(list, false, r.privateOnly === true)
    const ca = trustedCa(r.caPem)
    const tlsOptions = {
      minVersion: 'TLSv1.2' as const,
      ...(ca ? { ca } : {}),
      ...(target.literal ? {} : { servername: target.host }),
    }
    if (list.every((a) => listed(a.address)))
      return tlsConnect({ ...tlsOptions, host: list[0]!.address, port: target.port })
    const raw = await throughProxy(
      p,
      list.map((a) => a.address),
      target.port,
      r.signal,
    )
    return tlsConnect({ ...tlsOptions, socket: raw, host: target.host })
  }

  /**
   * W4.5: a socket to one of `addresses` (already judged) through the proxy's CONNECT. W4 review
   * (minors): each of the proxy's allowed addresses is tried until one connects, and each target
   * address until the proxy reaches one (a 407 is the credentials, final); a stop while the proxy
   * has not answered is a stop ("aborted"), not a proxy failure.
   */
  async function throughProxy(
    p: ProxySettings,
    addresses: string[],
    port: number,
    signal: AbortSignal | undefined,
  ): Promise<Socket> {
    // The proxy's own address: never a metadata or link-local one, whatever its name resolves to.
    const proxyList = isIP(p.host)
      ? [{ address: p.host, family: isIP(p.host) }]
      : await resolveAll(p.host).catch(() =>
          Promise.reject(new EgressError('proxy', 'The proxy’s name does not resolve')),
        )
    const proxyAddresses = proxyList.filter((a) => {
      const v = classifyAddress(a.address, allowed)
      return v.ok || v.reason === 'private' || v.reason === 'loopback'
    })
    if (!proxyAddresses.length) throw new EgressError('proxy', 'The proxy’s address is not allowed')
    let last: EgressError = new EgressError('proxy', 'The proxy cannot be reached')
    for (const address of addresses) {
      let reached = false
      for (const proxyAddress of proxyAddresses) {
        try {
          return await connectVia(p, proxyAddress.address, address, port, signal)
        } catch (e) {
          if (signal?.aborted) throw new EgressError('aborted', 'The request was stopped')
          last = mapError(e)
          // Not reached at this address: the proxy's next one.
          if (last.reason === 'proxy' && last.detail === 'unreachable') continue
          reached = true
          break
        }
      }
      // The proxy reached nowhere, or refused for another reason than the target (407: the
      // credentials): final. It answered that it could not reach this address (5xx): the next one.
      if (!reached || last.reason !== 'proxy' || !/^5[0-9][0-9]$/.test(last.detail ?? '')) throw last
    }
    throw last
  }

  /** One CONNECT through one of the proxy's addresses. */
  async function connectVia(
    p: ProxySettings,
    proxyAddress: string,
    address: string,
    port: number,
    signal: AbortSignal | undefined,
  ): Promise<Socket> {
    const raw = p.secure
      ? tlsConnect({
          host: proxyAddress,
          port: p.port,
          minVersion: 'TLSv1.2',
          ...(isIP(p.host) ? {} : { servername: p.host }),
        })
      : netConnect({ host: proxyAddress, port: p.port })
    let disposeAbort: Disposable | null = null
    if (signal) {
      if (signal.aborted) raw.destroy()
      else disposeAbort = addAbortListener(signal, () => raw.destroy())
    }
    try {
      // Not reached at all (refused, unreachable): said apart, so the proxy's next address is tried.
      await new Promise<void>((resolve, reject) => {
        const ready = p.secure ? 'secureConnect' : 'connect'
        const onError = () => {
          raw.off(ready, onReady)
          reject(new EgressError('proxy', 'The proxy cannot be reached', 'unreachable'))
        }
        const onReady = () => {
          raw.off('error', onError)
          raw.off('close', onError)
          resolve()
        }
        raw.once('error', onError)
        raw.once('close', onError)
        raw.once(ready, onReady)
      })
      const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`
      raw.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
          (p.authorization ? `Proxy-Authorization: ${p.authorization}\r\n` : '') +
          '\r\n',
      )
      const rest = await connectReply(raw, connectMs)
      if (rest.length) raw.unshift(rest)
      return raw
    } catch (e) {
      raw.destroy()
      throw e
    } finally {
      disposeAbort?.[Symbol.dispose]()
    }
  }

  /** A plain TCP connection to an address already judged, within the connect timeout. */
  function dial(address: string, port: number, signal: AbortSignal | undefined): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host: address, port })
      let disposeAbort: Disposable | null = null
      const done = () => {
        clearTimeout(timer)
        disposeAbort?.[Symbol.dispose]()
        disposeAbort = null
      }
      const fail = (e: unknown) => {
        done()
        s.destroy()
        reject(mapError(e))
      }
      const timer = setTimeout(
        () => fail(new EgressError('timeout', 'The destination did not answer in time')),
        connectMs,
      )
      if (signal)
        disposeAbort = addAbortListener(signal, () =>
          fail(new EgressError('aborted', 'The request was stopped')),
        )
      s.once('error', fail)
      s.once('connect', () => {
        done()
        s.off('error', fail)
        resolve(s)
      })
    })
  }

  /** W4 review (minor): each judged address in turn, until one connects (a stop ends it). */
  async function dialAny(
    addresses: string[],
    port: number,
    signal: AbortSignal | undefined,
  ): Promise<Socket> {
    let last: unknown = new EgressError('connect', 'The destination cannot be reached')
    for (const address of addresses) {
      try {
        return await dial(address, port, signal)
      } catch (e) {
        last = e
        if ((e as EgressError).reason === 'aborted') throw e
      }
    }
    throw last
  }

  /**
   * W3.3, W4.5: a plain TCP socket for a protocol of its own (SMTP; an SFTP destination's SSH
   * session, which brings its own encryption and host key check). The name is resolved and every
   * address judged as for https (no "plain http" rule); the judged address is dialled, so what is
   * checked is what is connected to. With `viaProxy`, a target outside the listed networks goes
   * through the egress's proxy when one is set (CONNECT to the judged address).
   */
  async function socket(r: SocketRequest): Promise<Socket> {
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65_535)
      throw new EgressError('bad_url', 'The destination’s address is not valid')
    const host = r.host.replace(/^\[|\]$/g, '')
    if (!host || /[\s/@]/.test(host))
      throw new EgressError('bad_url', 'The destination’s address is not valid')
    if (r.signal?.aborted) throw new EgressError('aborted', 'The request was stopped')
    const t0 = performance.now()
    const list = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolveAll(host).catch((e) => Promise.reject(mapError(e)))
    judge(list, false)
    const t1 = performance.now()
    const address = list[0]!.address
    const addresses = list.map((a) => a.address)
    const s =
      r.viaProxy && proxy && !list.every((a) => listed(a.address))
        ? await throughProxy(proxy, addresses, r.port, r.signal)
        : await dialAny(addresses, r.port, r.signal)
    if (r.signal?.aborted) {
      s.destroy()
      throw new EgressError('aborted', 'The request was stopped')
    }
    r.onTiming?.({ address, resolveMs: Math.round(t1 - t0), connectMs: Math.round(performance.now() - t1) })
    return s
  }

  function request(r: EgressRequest): Promise<EgressResponse> {
    // Review of db45c424 (M-5): refused before it is sent, a request lets go of its body (a file
    // handle, which on Windows also locks the file).
    const refuse = (e: EgressError) => {
      if (r.body && !Buffer.isBuffer(r.body)) r.body.destroy()
      return Promise.reject(e)
    }
    let parsed: ReturnType<typeof parse>
    try {
      parsed = parse(r.url)
      if (parsed.literal)
        judge([{ address: parsed.host }], parsed.url.protocol !== 'https:', r.privateOnly === true)
    } catch (e) {
      return refuse(mapError(e))
    }
    const { url, host, literal } = parsed
    const secure = url.protocol === 'https:'
    if (r.signal?.aborted) return refuse(new EgressError('aborted', 'The request was stopped'))
    const mod = secure ? https : http
    return new Promise((resolve, reject) => {
      let settled = false
      // The answer being read, so a timeout or an abort ends it with our reason, not "aborted".
      let current: IncomingMessage | null = null
      // Phase 3d-3b final review: the abort listener and the deadline live as long as the exchange —
      // removed when it fails or its answer closes, so a caller's signal does not collect listeners.
      let disposeAbort: Disposable | null = null
      let deadline: NodeJS.Timeout | null = null
      const cleanup = () => {
        disposeAbort?.[Symbol.dispose]()
        disposeAbort = null
        if (deadline) clearTimeout(deadline)
        deadline = null
      }
      let bodyFailure: EgressError | undefined
      const fail = (e: unknown) => {
        cleanup()
        if (settled) return
        settled = true
        reject(bodyFailure ?? mapError(e))
      }
      // A fresh agent: no pooled socket, and no process-wide proxy settings (NODE_USE_ENV_PROXY).
      const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
      // W4.5: with a proxy, the agent's socket is the one tlsSocket judged and opened.
      if (proxy && secure) {
        const port = Number(url.port || 443)
        ;(agent as unknown as { createConnection: unknown }).createConnection = (
          _options: unknown,
          callback: (e: Error | null, s?: TLSSocket) => void,
        ) => {
          tlsSocket(proxy, { host, port, literal }, r).then(
            (s) => callback(null, s),
            (e: unknown) => callback(mapError(e)),
          )
          return undefined
        }
      }
      const ca = trustedCa(r.caPem)
      const req = mod.request(url, {
        method: r.method,
        headers: r.headers,
        agent,
        maxHeaderSize: HEADER_BYTES,
        lookup: guardedLookup(!secure, r.privateOnly === true),
        ...(secure
          ? {
              minVersion: 'TLSv1.2' as const,
              ...(ca ? { ca } : {}),
              ...(literal ? {} : { servername: host }),
            }
          : {}),
      })
      const stop = (e: EgressError) => {
        current?.destroy(e)
        req.destroy(e)
      }
      if (r.signal)
        disposeAbort = addAbortListener(r.signal, () =>
          stop(new EgressError('aborted', 'The request was stopped')),
        )
      if (r.deadlineMs !== undefined)
        deadline = setTimeout(
          () => stop(new EgressError('timeout', 'The destination took too long to answer')),
          r.deadlineMs,
        )
      req.on('close', () => {
        if (!current) cleanup()
      })
      req.on('socket', (socket) => {
        const timer = setTimeout(
          () => stop(new EgressError('timeout', 'The destination did not answer in time')),
          connectMs,
        )
        socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(timer))
        socket.once('close', () => clearTimeout(timer))
      })
      req.setTimeout(idleMs, () => stop(new EgressError('timeout', 'The destination stopped answering')))
      // Before the body's pipeline: a network failure reaches `fail` first, and only after it does
      // pipeline destroy the body (with that error), so it is never taken for the body's own.
      req.on('error', fail)
      req.on('response', (res) => {
        current = res
        res.on('error', () => undefined)
        res.once('close', cleanup)
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          // Phase 3d-3b final review: dropped, never drained — a server could stream for ever.
          discard(res)
          let where: string | undefined
          let target: string | undefined
          try {
            const next = new URL(res.headers.location, url)
            where = next.host
            target = next.href
          } catch {
            // no detail
          }
          // The host is a detail for administrators only: the message reaches users' copy errors.
          return fail(
            new EgressError(
              'redirect',
              'The destination answered with a redirect; redirects are not followed',
              where,
              target,
            ),
          )
        }
        settled = true
        resolve({ status, headers: res.headers, body: res, remoteAddress: res.socket?.remoteAddress ?? null })
      })
      if (r.body === undefined) req.end()
      else if (Buffer.isBuffer(r.body)) req.end(r.body)
      else {
        // Review of the stream errors (2026-10-20): a body that cannot be read (a file gone before
        // its send) is not a broken connection, to be retried as one; it is said as what it is.
        r.body.once('error', (e: NodeJS.ErrnoException) => {
          bodyFailure = new EgressError('body', 'The data to send could not be read', e?.code)
        })
        pipeline(r.body, req, (e) => e && req.destroy(e))
      }
    })
  }

  async function buffer(r: EgressRequest, limit = JSON_LIMIT) {
    const res = await request({ deadlineMs: smallDeadlineMs, ...r })
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const c of res.body) {
        size += (c as Buffer).length
        if (size > limit) {
          res.body.destroy()
          throw new EgressError('too_large', 'The destination sent too large an answer')
        }
        chunks.push(c as Buffer)
      }
    } catch (e) {
      throw mapError(e)
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) }
  }

  async function probe(u: string | URL, caPem?: string, signal?: AbortSignal) {
    const { url, host, literal } = parse(u)
    const t0 = performance.now()
    if (literal) judge([{ address: host }], url.protocol === 'http:')
    else judge(await resolveAll(host).catch((e) => Promise.reject(mapError(e))), url.protocol === 'http:')
    const t1 = performance.now()
    const res = await request({
      method: 'HEAD',
      url: new URL('/', url),
      ...(caPem ? { caPem } : {}),
      ...(signal ? { signal } : {}),
    })
    discard(res.body)
    return { resolveMs: Math.round(t1 - t0), connectMs: Math.round(performance.now() - t1) }
  }

  const listed = (address: string): boolean => {
    const v = classifyAddress(address, allowed)
    return v.ok && v.allowedNetwork
  }

  return { request, buffer, probe, listed, socket }
}

/**
 * Phase 3d-3b final review: an answer that is not wanted is dropped, not drained — keep-alive is off,
 * so nothing is gained by reading it, and a server could stream without end.
 */
export function discard(body: Readable): void {
  body.destroy()
}

/**
 * Phase 3d-3b final review (A12): the body of a ranged GET from `offset` on. A 200 (range ignored)
 * is skipped up to the offset; a 206 must say where it starts — at the offset, or earlier (skipped
 * up to it). Anything else would splice the wrong bytes onto what is already held. A 206 without a
 * Content-Range (which HTTP requires) is taken as the range asked for: no other start can be known,
 * and a fetch is complete only once the whole object's digest matches.
 */
export function rangedBody(res: EgressResponse, offset: number): Readable {
  if (offset <= 0) return res.body
  let start: number
  const range = res.headers['content-range']
  if (res.status === 206 && range !== undefined) {
    const m = /^bytes (\d{1,16})-\d{1,16}\/(?:\d{1,16}|\*)$/.exec(String(range).trim())
    start = m ? Number(m[1]) : NaN
    if (!Number.isSafeInteger(start) || start > offset) {
      discard(res.body)
      throw new EgressError('network', 'The destination answered another range than the one asked for')
    }
  } else start = res.status === 206 ? offset : 0
  let skip = offset - start
  if (skip === 0) return res.body
  const skipper = new Transform({
    transform(chunk: Buffer, _e, cb) {
      if (skip >= chunk.length) {
        skip -= chunk.length
        return cb()
      }
      const rest = chunk.subarray(skip)
      skip = 0
      cb(null, rest)
    },
  })
  // pipeline, not pipe: a failure of the answer reaches the reader instead of leaving it waiting.
  return pipeline(res.body, skipper, () => undefined)
}

/**
 * Phase 3d-3b final review (A16): a small answer read whole, bounded in size and in total time — the
 * idle timer alone lets a server send one byte a minute for hours. Over the limit: too_large, or with
 * `truncate` the first `limit` bytes (an error text).
 */
export async function readBounded(
  body: Readable,
  limit: number,
  opts: { ms?: number; truncate?: boolean } = {},
): Promise<Buffer> {
  const timer = setTimeout(
    () => body.destroy(new EgressError('timeout', 'The destination took too long to answer')),
    opts.ms ?? SMALL_ANSWER_MS,
  )
  const chunks: Buffer[] = []
  let n = 0
  try {
    for await (const c of body) {
      const chunk = c as Buffer
      if (n + chunk.length > limit) {
        if (opts.truncate) {
          chunks.push(chunk.subarray(0, limit - n))
          break
        }
        throw new EgressError('too_large', 'The destination sent too large an answer')
      }
      n += chunk.length
      chunks.push(chunk)
    }
  } catch (e) {
    throw mapError(e)
  } finally {
    clearTimeout(timer)
    body.destroy()
  }
  return Buffer.concat(chunks)
}

/** Linear: a BEGIN without its END is redacted to the end of the text (still a key). */
function redactPem(text: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const begin = text.indexOf('-----BEGIN ', at)
    if (begin < 0) return out + text.slice(at)
    out += `${text.slice(at, begin)}[redacted key]`
    const end = text.indexOf('-----END ', begin)
    if (end < 0) return out
    const close = text.indexOf('-----', end + 9)
    if (close < 0) return out
    at = close + 5
  }
}

const SECRET_FIELD =
  /\b(authorization|x-api-key|api[_-]?key|x-amz-security-token|x-amz-signature|signature|credential|access_token|refresh_token|id_token|client_secret|private_key|password|upload_id|uploadid|assertion|code)(["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi

/** Spec §3: a provider's text, safe to show an administrator or keep in a log. */
export function scrubText(text: string): string {
  // Phase 3d-3b final review: bounded first (only 300 characters are kept), and no regular
  // expression that rescans the text (many unterminated BEGIN lines made the PEM one quadratic).
  return (
    redactPem(text.slice(0, 64 * 1024))
      .replace(/https?:\/\/[^\s"'<>]+/g, (u) =>
        u
          .split(/[?#]/)[0]!
          // user:password@ (or a bare user@) in front of the host.
          .replace(/^(https?:\/\/)[^/@]*@/i, '$1[redacted]@'),
      )
      .replace(/\bAWS4-HMAC-SHA256 [^\n]*/g, 'AWS4-HMAC-SHA256 [redacted]')
      // An Authorization value is a scheme and a credential ("Basic dXNl…"): both go.
      .replace(
        /\b((?:proxy-)?authorization["']?\s*[=:]\s*["']?)(?:[A-Za-z][\w-]*\s+)?[^\s"'&,;]+/gi,
        '$1[redacted]',
      )
      .replace(SECRET_FIELD, '$1$2[redacted]')
      .replace(/\b(ya29\.|1\/\/)[A-Za-z0-9._\-/]+/g, '[redacted]')
      .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
      .slice(0, 300)
  )
}
