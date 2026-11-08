// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'

/**
 * Phase 3a-1 spec §3.2 and §5.1: the worker's only allowed connection is to its session proxy on
 * loopback. Every other network path is refused.
 *
 * The driver connects to the connection's real host names; the wrapped `net` redirects every such
 * connection to the loopback proxy, writing a preamble that names the intended host. The proxy
 * checks the session token and the host allow-list, then does TLS, SSH and auth upstream. No DNS is
 * ever performed in the worker (we dial a literal IP), and DNS, UDP, TLS and HTTP are refused, so
 * user code cannot reach any other address.
 */
export const NETWORK_ERROR_CODE = 'ERR_MM_SHELL_NETWORK'

function refuse(): never {
  const e = new Error('The shell sandbox allows no network access')
  ;(e as NodeJS.ErrnoException).code = NETWORK_ERROR_CODE
  throw e
}

/** token is 32 bytes as 64 hex chars; the target is at most 300 bytes of "host:port". */
function preamble(token: string, host: string, port: number): Buffer {
  const target = Buffer.from(`${host}:${port}`, 'utf8')
  if (target.length > 300) refuse()
  const head = Buffer.alloc(32 + 2)
  Buffer.from(token, 'hex').copy(head, 0)
  head.writeUInt16BE(target.length, 32)
  return Buffer.concat([head, target])
}

/** Make a property non-writable and non-configurable so user code cannot restore the original. */
function freeze(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: false, configurable: false, enumerable: false })
}

/**
 * Redirect every socket connection to the proxy. Called before any user code and before the driver
 * connects. `host`/`port` in the call are the intended upstream, sent to the proxy as the target.
 */
export function lockNetwork(proxyPort: number, token: string): void {
  const PROXY_HOST = '127.0.0.1'
  // Capture the real connect before overriding it, so our own redirect does not recurse.
  const realProtoConnect = net.Socket.prototype.connect as (
    this: net.Socket,
    port: number,
    host: string,
    connectListener?: () => void,
  ) => net.Socket

  // Parse the driver's various connect signatures into { host, port } or null (a non-TCP target).
  const targetOf = (arg: unknown, arg2?: unknown): { host: string; port: number } | null => {
    if (typeof arg === 'number' || typeof arg === 'string') {
      const port = Number(arg)
      if (!Number.isInteger(port) || port <= 0) return null
      const host = typeof arg2 === 'string' ? arg2 : 'localhost'
      return { host, port }
    }
    if (arg && typeof arg === 'object') {
      const o = arg as { host?: unknown; port?: unknown; path?: unknown }
      // A Unix socket or Windows named pipe: never allowed.
      if (o.path !== undefined) return null
      const port = Number(o.port)
      if (!Number.isInteger(port) || port <= 0) return null
      return { host: typeof o.host === 'string' ? o.host : 'localhost', port }
    }
    return null
  }

  const dial = (target: { host: string; port: number } | null, listener?: unknown): net.Socket => {
    if (!target) refuse()
    const socket = new net.Socket()
    if (typeof listener === 'function') socket.once('connect', listener as () => void)
    // Use the real connect, not our override, or this would redirect to the proxy twice.
    realProtoConnect.call(socket, proxyPort, PROXY_HOST)
    // Write the preamble now: it buffers and flushes first, before the driver's own connect
    // listener writes its hello. Writing it in the connect callback would arrive after.
    socket.write(preamble(token, target.host, target.port))
    return socket
  }

  const connect = (arg: unknown, arg2?: unknown, arg3?: unknown): net.Socket => {
    // The listener is the last function argument in net.connect's overloads.
    const listener = [arg3, arg2].find((a) => typeof a === 'function')
    return dial(targetOf(arg, arg2), listener)
  }

  freeze(net, 'connect', connect)
  freeze(net, 'createConnection', connect)

  // Socket.prototype.connect is what the driver ultimately calls; redirect it to the proxy too.
  freeze(
    net.Socket.prototype,
    'connect',
    function (this: net.Socket, arg: unknown, arg2?: unknown, arg3?: unknown) {
      const target = targetOf(arg, arg2)
      if (!target) refuse()
      const listener = [arg3, arg2].find((a) => typeof a === 'function')
      if (typeof listener === 'function') this.once('connect', listener as () => void)
      realProtoConnect.call(this, proxyPort, PROXY_HOST)
      // Buffered now so it flushes before the driver's hello (see dial).
      this.write(preamble(token, target.host, target.port))
      return this
    },
  )

  // No TLS in the worker: the proxy speaks TLS upstream, the worker speaks plaintext over loopback.
  freeze(tls, 'connect', refuse)
  freeze(tls, 'createSecureContext', refuse)
  freeze(tls, 'TLSSocket', refuse)

  // No DNS, UDP, HTTP: nothing but the redirected TCP path may leave the process.
  for (const key of Object.keys(dns) as (keyof typeof dns)[]) {
    if (typeof dns[key] === 'function') freeze(dns, key as string, refuse)
  }
  for (const key of Object.keys(dns.promises)) freeze(dns.promises, key, refuse)
  // Security audit 2026-10-16 (Important 4): UDP through dgram's constructor too (it takes its own
  // lookup, so no DNS function is needed), the handle helper, and any UDP socket's way out — on the
  // shared prototype, so a socket made from a constructor kept elsewhere cannot send either.
  const udp = dgram.Socket.prototype as unknown as Record<string, unknown>
  for (const key of ['bind', 'connect', 'send', 'sendto']) if (key in udp) freeze(udp, key, refuse)
  freeze(dgram, 'createSocket', refuse)
  freeze(dgram, 'Socket', refuse)
  freeze(dgram, '_createSocketHandle', refuse)
  for (const mod of [http, https]) {
    freeze(mod, 'request', refuse)
    freeze(mod, 'get', refuse)
  }
  freeze(http2, 'connect', refuse)

  // Nothing may listen (audit Important 4): a listening worker would let anyone who reaches it relay
  // into the authenticating proxy. net, http, https, tls and http2 servers all listen through
  // net.Server, whose listen and its old _listen2 alias are refused; the factories and the handle
  // helper are refused too.
  const server = net.Server.prototype as unknown as Record<string, unknown>
  for (const key of ['listen', '_listen2']) if (key in server) freeze(server, key, refuse)
  freeze(net, '_createServerHandle', refuse)
  freeze(net, 'createServer', refuse)
  freeze(http, 'createServer', refuse)
  freeze(https, 'createServer', refuse)
  freeze(tls, 'createServer', refuse)
  freeze(http2, 'createServer', refuse)
  freeze(http2, 'createSecureServer', refuse)

  // Remove the fetch family and other network globals from the worker's own global scope.
  for (const key of ['fetch', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers', 'navigator']) {
    try {
      delete (globalThis as Record<string, unknown>)[key]
    } catch {
      // Non-configurable globals (none of these are on Node today) stay; the vm context omits them anyway.
    }
  }
}
