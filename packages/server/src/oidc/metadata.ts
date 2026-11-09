// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EgressError, type Egress } from '../net/egress'

/**
 * W7 (completion): an identity provider's metadata (OpenID Connect discovery, RFC 8414), read
 * through the egress guard — the issuer comes from the MongoDB server, so it is an address someone
 * else chose: public, or inside MM_OIDC_PRIVATE_NETWORKS; https (http only there); no redirects.
 */
export interface IssuerMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
  revocationEndpoint?: string
}

export type OidcReason =
  | 'oidc_issuer'
  | 'oidc_issuer_unreachable'
  | 'oidc_pkce'
  | 'oidc_state'
  | 'oidc_denied'
  | 'oidc_token'
  | 'oidc_id_token'
  | 'oidc_device_unsupported'
  | 'oidc_no_idp'
  | 'oidc_busy'
  | 'oidc_issuer_mismatch'
  | 'oidc_device_off'
  | 'oidc_redirect_foreign'

/** A refusal with a reason the UI says in the user's language; never a token, never IdP text. */
export class OidcFlowError extends Error {
  override name = 'OidcFlowError'
  constructor(
    readonly reason: OidcReason,
    message: string,
  ) {
    super(message)
  }
}

const METADATA_LIMIT = 256 * 1024
const CACHE_MS = 10 * 60_000

/** The issuer as an address: https or http, no credentials, query or fragment. */
export function issuerUrl(issuer: string): URL {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new OidcFlowError('oidc_issuer', 'The identity provider the server names is not a valid address')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new OidcFlowError(
      'oidc_issuer',
      'The identity provider the server names is not a plain https address',
    )
  return url
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/**
 * An endpoint of the metadata: https; plain http only on the issuer's own host when the issuer is
 * itself http (the egress guard allowed it: a listed private network). The browser is sent to the
 * authorization endpoint, so it must never be another scheme.
 */
function endpoint(value: unknown, issuer: URL, name: string): string {
  if (typeof value !== 'string')
    throw new OidcFlowError('oidc_issuer', `The identity provider gives no ${name}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OidcFlowError('oidc_issuer', `The identity provider’s ${name} is not a valid address`)
  }
  const httpOk = issuer.protocol === 'http:' && url.protocol === 'http:' && url.host === issuer.host
  if ((url.protocol !== 'https:' && !httpOk) || url.username || url.password || url.hash)
    throw new OidcFlowError('oidc_issuer', `The identity provider’s ${name} is not an https address`)
  return url.href
}

export class MetadataCache {
  private readonly cache = new Map<string, { at: number; metadata: IssuerMetadata }>()
  constructor(
    private readonly egress: Egress,
    private readonly now: () => number,
  ) {}

  async get(issuer: string): Promise<IssuerMetadata> {
    const hit = this.cache.get(issuer)
    if (hit && this.now() - hit.at < CACHE_MS) return hit.metadata
    const metadata = await discover(this.egress, issuer)
    if (this.cache.size > 100) this.cache.clear()
    this.cache.set(issuer, { at: this.now(), metadata })
    return metadata
  }
}

export async function discover(egress: Egress, issuer: string): Promise<IssuerMetadata> {
  const base = issuerUrl(issuer)
  const url = `${trimSlash(base.href)}/.well-known/openid-configuration`
  let body: Buffer
  let status: number
  try {
    ;({ status, body } = await egress.buffer(
      { method: 'GET', url, headers: { accept: 'application/json' }, deadlineMs: 15_000 },
      METADATA_LIMIT,
    ))
  } catch (e) {
    const reason = e instanceof EgressError ? e.reason : 'network'
    throw new OidcFlowError(
      'oidc_issuer_unreachable',
      reason === 'address_refused' || reason === 'http_refused'
        ? 'The identity provider is on a private network that is not allowed (MM_OIDC_PRIVATE_NETWORKS)'
        : reason === 'address_never'
          ? 'The identity provider’s address can never be reached'
          : 'The identity provider could not be reached',
    )
  }
  if (status !== 200)
    throw new OidcFlowError(
      'oidc_issuer_unreachable',
      `The identity provider answered ${status} to its discovery`,
    )
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(body.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new OidcFlowError('oidc_issuer', 'The identity provider’s metadata is not JSON')
  }
  // RFC 8414 §3.3 (mix-up defence): the metadata must be the issuer's own.
  if (typeof doc.issuer !== 'string' || trimSlash(doc.issuer) !== trimSlash(issuer))
    throw new OidcFlowError('oidc_issuer', 'The identity provider’s metadata names another issuer')
  const methods = doc.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256'))
    throw new OidcFlowError('oidc_pkce', 'The identity provider does not offer PKCE with S256')
  return {
    issuer,
    authorizationEndpoint: endpoint(doc.authorization_endpoint, base, 'authorization endpoint'),
    tokenEndpoint: endpoint(doc.token_endpoint, base, 'token endpoint'),
    ...(doc.device_authorization_endpoint !== undefined
      ? { deviceAuthorizationEndpoint: endpoint(doc.device_authorization_endpoint, base, 'device endpoint') }
      : {}),
    ...(doc.revocation_endpoint !== undefined
      ? { revocationEndpoint: endpoint(doc.revocation_endpoint, base, 'revocation endpoint') }
      : {}),
  }
}
