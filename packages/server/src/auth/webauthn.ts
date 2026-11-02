import type { FastifyRequest } from 'fastify'
import { ownOrigin } from '../http/security'

export interface RelyingParty {
  rpID: string
  origin: string
}

/** Derived per request so reverse proxies (trusted via trustProxy) produce the public origin. */
export function relyingParty(request: FastifyRequest): RelyingParty {
  return { rpID: request.hostname.replace(/^\[|\]$/g, ''), origin: ownOrigin(request) }
}

export type PasskeySupport =
  { available: true } | { available: false; reason: 'ip-address' | 'insecure-context'; message: string }

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Browsers only allow WebAuthn in secure contexts (HTTPS or localhost), and an RP ID must be a
 * domain name, never an IP address. The UI uses this to explain why passkeys are unavailable.
 */
export function passkeySupport(request: FastifyRequest): PasskeySupport {
  const host = relyingParty(request).rpID.toLowerCase()
  const isLocalhost = host === 'localhost' || host.endsWith('.localhost')
  if (IPV4.test(host) || host.includes(':')) {
    return {
      available: false,
      reason: 'ip-address',
      message:
        'Passkeys cannot be used on an IP address. Open Mongo Manager via http://localhost or an HTTPS domain name.',
    }
  }
  if (request.protocol !== 'https' && !isLocalhost) {
    return {
      available: false,
      reason: 'insecure-context',
      message:
        'Passkeys need HTTPS on this address. Put Mongo Manager behind HTTPS or open it via http://localhost.',
    }
  }
  return { available: true }
}
