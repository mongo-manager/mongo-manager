import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'
import { isLoopbackHost, type Config } from '../config'
import { Errors } from '../errors'

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * Spec §5 S20: whether a Host header's name (lower case, port removed) is accepted. The configured
 * list when there is one; loopback names on a loopback bind. Security audit 2026-10-16: a network
 * bind without a list took any name, so a rebinding name (evil.example resolving to this server) was
 * same-origin with the app and passkeys took it as their relying party. It now takes addresses and
 * loopback names only — rebinding needs a name — so the documented setups (Docker published on the
 * host loopback, a LAN address) keep working; a name is opened once it is listed.
 */
export function hostAllowlist(config: Config): (hostname: string) => boolean {
  if (config.allowedHosts.length > 0) {
    const listed = new Set(config.allowedHosts.map((h) => h.toLowerCase()))
    return (hostname) => listed.has(hostname)
  }
  const loopback = new Set(LOOPBACK_NAMES)
  if (isLoopbackHost(config.host)) return (hostname) => loopback.has(hostname)
  return (hostname) => loopback.has(hostname) || isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
}

/** Exact match on the path (query string ignored), so "?x=/healthz" cannot borrow the exemption. */
export function isHealthPath(url: string, prefix: string): boolean {
  const path = url.split('?', 1)[0]
  return path === `${prefix}/healthz` || path === `${prefix}/readyz`
}

/** "https://host:443" and "https://host" are the same origin; browsers omit default ports. */
export function normalizeOrigin(protocol: string, host: string): string {
  const lower = host.toLowerCase()
  const defaultPort = protocol === 'https' ? ':443' : protocol === 'http' ? ':80' : ''
  return `${protocol}://${defaultPort && lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower}`
}

export function ownOrigin(request: FastifyRequest): string {
  return normalizeOrigin(request.protocol, request.host)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Browsers always send Origin on mutating fetches; it must be exactly our own origin. */
export function checkOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin
  if (origin !== undefined) {
    const match = /^(https?):\/\/(.+)$/.exec(origin)
    if (!match || normalizeOrigin(match[1]!, match[2]!) !== ownOrigin(request)) {
      throw Errors.forbidden('Cross-origin request blocked')
    }
    return
  }
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw Errors.forbidden('Cross-origin request blocked')
  }
}

export async function csrfGuard(request: FastifyRequest): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return
  checkOrigin(request)
  if (request.routeOptions.config?.csrf === false) return
  const principal = request.principal
  if (!principal) return
  const token = request.headers['x-csrf-token']
  if (typeof token !== 'string' || !safeEqual(token, principal.csrfToken)) {
    // The reason lets a client whose token was rotated by another tab refresh it once and retry.
    throw Errors.forbidden('Missing or invalid CSRF token', { reason: 'csrf' })
  }
}
