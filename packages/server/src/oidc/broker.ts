// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IdPInfo, OIDCCallbackFunction, OIDCResponse } from 'mongodb'
import type { Egress } from '../net/egress'
import { OIDC_SIGN_IN_NEEDED } from '../connections/errors'
import { safeEqual } from '../http/security'
import { MetadataCache, OidcFlowError, issuerUrl, type IssuerMetadata } from './metadata'
import type { OidcIdentity, OidcTokenRepo, OidcTokens } from './tokens'

export { OidcFlowError } from './metadata'

/**
 * W7 (completion): MONGODB-OIDC sign-in for people, the way the MongoDB driver's human workflow
 * expects it. The driver asks this broker for a token (OIDC_HUMAN_CALLBACK) and is given the
 * person's own, sealed in the store, refreshed with their refresh token — or told to sign in. The
 * sign-in itself happens in the person's browser: the authorization code flow with PKCE, state and
 * nonce (RFC 6749, 7636, OIDC Core), bound to the browser that started it; the device flow (RFC
 * 8628) where the redirect cannot reach this server. Tokens never reach a browser and are never
 * logged; every call to the identity provider goes through the egress guard.
 */
export interface BrokerDeps {
  egress: Egress
  tokens: OidcTokenRepo
  now(): number
  /** Closes a person's clients of a connection: their driver keeps the tokens it was given. */
  invalidate(connectionId: string, user: string): Promise<void>
  /** The identity provider the MongoDB server names (a connection attempt that stops at it). */
  probe(connectionId: string, user: string): Promise<IdPInfo>
  /**
   * Security review I5: the issuer an administrator expects for a connection, if they set one — any
   * other the MongoDB server names is refused.
   */
  expectedIssuer?(connectionId: string): string | undefined
  warn?(fields: Record<string, unknown>, message: string): void
}

export interface OidcStatus {
  signedIn: boolean
  issuer?: string
  /** When the access token expires (ms); null: not said. */
  expiresAt?: number | null
  device?: {
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresAt: number
    state: DeviceState
    /** The identity provider the code is for (security review I5). */
    issuer: string
  }
  /** Security review I6: a device sign-in completed by this very poll, and who it signed in. */
  completed?: OidcIdentity
}

type DeviceState = 'pending' | 'done' | 'denied' | 'expired' | 'failed'

interface Idp {
  issuer: string
  clientId: string
  requestScopes: string[]
}

interface CodeFlow {
  connectionId: string
  user: string
  verifier: string
  nonce: string
  redirectUri: string
  idp: Idp
  tokenEndpoint: string
  bindingHash: Buffer
  returnTo: string
  expiresAt: number
}

interface DeviceFlow {
  connectionId: string
  user: string
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
  state: DeviceState
  idp: Idp
  tokenEndpoint: string
}

const FLOW_MS = 10 * 60_000
const DEVICE_MAX_MS = 15 * 60_000
const IDP_MS = 60 * 60_000
const TOKEN_LIMIT = 64 * 1024
/** A token used until it has less than this left; then refreshed first. */
const EARLY_MS = 60_000
const MAX_CODE_FLOWS = 1000
const MAX_DEVICE_FLOWS = 100
/** Security review Minor 6: device sign-ins one person may have waiting, over every connection. */
const MAX_DEVICE_FLOWS_PER_USER = 3

const random = () => randomBytes(32).toString('base64url')
const sha256 = (text: string) => createHash('sha256').update(text).digest()
/**
 * Security review Minor 1: a code flow's id, from its state — names the flow's own binding cookie, so
 * several sign-ins (tabs, connections) can wait at once. Not the state: a hash of it, cut short.
 */
export const flowIdOf = (state: string): string => sha256(`flow:${state}`).toString('base64url').slice(0, 16)
const trimSlash = (s: string) => s.replace(/\/+$/, '')
const keyOf = (connectionId: string, user: string) => `${connectionId}\u0000${user}`
/** An OAuth error code is a short token; anything else an identity provider says is not shown. */
const errorCode = (v: unknown) => (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : 'error')

function checkIdp(info: IdPInfo | undefined): Idp {
  if (!info || typeof info.issuer !== 'string' || typeof info.clientId !== 'string' || !info.clientId)
    throw new OidcFlowError('oidc_no_idp', 'The MongoDB server named no identity provider')
  if (info.clientId.length > 512)
    throw new OidcFlowError('oidc_no_idp', 'The client ID the server names is too long')
  issuerUrl(info.issuer)
  const scopes = (Array.isArray(info.requestScopes) ? info.requestScopes : [])
    .filter((s): s is string => typeof s === 'string' && /^[\x21-\x7e]{1,256}$/.test(s))
    .slice(0, 20)
  return { issuer: info.issuer, clientId: info.clientId, requestScopes: scopes }
}

/** The claims of an ID token (from the token endpoint directly, over TLS: OIDC Core 3.1.3.7). */
function idTokenClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split('.')[1]
  if (!part || idToken.length > TOKEN_LIMIT)
    throw new OidcFlowError('oidc_id_token', 'The ID token is not valid')
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new OidcFlowError('oidc_id_token', 'The ID token is not valid')
  }
}

export class OidcBroker {
  private readonly metadata: MetadataCache
  private readonly idps = new Map<string, { at: number; idp: Idp }>()
  private readonly codeFlows = new Map<string, CodeFlow>()
  private readonly deviceFlows = new Map<string, DeviceFlow>()
  /** One refresh at a time per person and connection: a rotated refresh token works only once. */
  private readonly refreshing = new Map<string, Promise<OIDCResponse>>()

  constructor(private readonly deps: BrokerDeps) {
    this.metadata = new MetadataCache(deps.egress, deps.now)
  }

  private remember(connectionId: string, info: IdPInfo | undefined): Idp | null {
    let idp: Idp
    try {
      idp = checkIdp(info)
    } catch {
      return null
    }
    this.expected(connectionId, idp)
    this.idps.set(connectionId, { at: this.deps.now(), idp })
    return idp
  }

  /** Security review I5: the issuer an administrator expects, when they set one. */
  private expected(connectionId: string, idp: Idp): void {
    const want = this.deps.expectedIssuer?.(connectionId)
    if (want && trimSlash(want) !== trimSlash(idp.issuer))
      throw new OidcFlowError(
        'oidc_issuer_mismatch',
        `The MongoDB server names ${issuerUrl(idp.issuer).host} as its identity provider, not the one this connection expects`,
      )
  }

  private async idpFor(connectionId: string, user: string): Promise<Idp> {
    const hit = this.idps.get(connectionId)
    const idp =
      hit && this.deps.now() - hit.at < IDP_MS ? hit.idp : checkIdp(await this.deps.probe(connectionId, user))
    this.expected(connectionId, idp)
    this.idps.set(connectionId, { at: hit?.idp === idp ? hit.at : this.deps.now(), idp })
    return idp
  }

  /** A form post to the identity provider; its JSON answer, or an error by its code only. */
  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    let status: number
    let body: Buffer
    try {
      ;({ status, body } = await this.deps.egress.buffer(
        {
          method: 'POST',
          url,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: Buffer.from(new URLSearchParams(form).toString()),
          deadlineMs: 30_000,
        },
        TOKEN_LIMIT,
      ))
    } catch {
      throw new OidcFlowError('oidc_issuer_unreachable', 'The identity provider could not be reached')
    }
    let doc: Record<string, unknown> = {}
    try {
      doc = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    } catch {
      // Not JSON: said by the status below.
    }
    if (status !== 200) {
      const code = errorCode(doc.error)
      const err = new OidcFlowError('oidc_token', `The identity provider refused: ${code}`)
      ;(err as OidcFlowError & { code?: string }).code = code
      throw err
    }
    return doc
  }

  private tokensFrom(
    doc: Record<string, unknown>,
    previous?: { refreshToken?: string | undefined; identity?: OidcIdentity | undefined },
    identity?: OidcIdentity,
  ): OidcTokens {
    const previousRefresh = previous?.refreshToken
    const who = identity ?? previous?.identity
    const access = doc.access_token
    if (typeof access !== 'string' || !access || access.length > TOKEN_LIMIT)
      throw new OidcFlowError('oidc_token', 'The identity provider gave no access token')
    if (typeof doc.token_type === 'string' && doc.token_type.toLowerCase() !== 'bearer')
      throw new OidcFlowError('oidc_token', 'The identity provider gave another kind of token')
    const refresh =
      typeof doc.refresh_token === 'string' && doc.refresh_token.length <= TOKEN_LIMIT
        ? doc.refresh_token
        : previousRefresh
    const expiresIn = Number(doc.expires_in)
    return {
      accessToken: access,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: this.deps.now() + expiresIn * 1000 }
        : {}),
      ...(who ? { identity: who } : {}),
    }
  }

  /** The ID token checked; who it says signed in (security review I6), when it says so. */
  private checkIdToken(
    doc: Record<string, unknown>,
    idp: Idp,
    nonce: string | null,
  ): OidcIdentity | undefined {
    if (typeof doc.id_token !== 'string') return undefined
    const claims = idTokenClaims(doc.id_token)
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const exp = Number(claims.exp) * 1000
    if (
      typeof claims.iss !== 'string' ||
      trimSlash(claims.iss) !== trimSlash(idp.issuer) ||
      !aud.includes(idp.clientId) ||
      (nonce !== null && claims.nonce !== nonce) ||
      !(exp > this.deps.now() - EARLY_MS)
    )
      throw new OidcFlowError('oidc_id_token', 'The identity provider’s ID token is not for this sign-in')
    const short = (v: unknown) => (typeof v === 'string' && v && v.length <= 256 ? v : undefined)
    const subject = short(claims.sub)
    if (!subject) return undefined
    const name = short(claims.preferred_username) ?? short(claims.email)
    return { subject, ...(name ? { name } : {}) }
  }

  private response(tokens: OidcTokens): OIDCResponse {
    const left = tokens.expiresAt ? Math.floor((tokens.expiresAt - this.deps.now()) / 1000) : undefined
    return {
      accessToken: tokens.accessToken,
      ...(left !== undefined && left > 0 ? { expiresInSeconds: left } : {}),
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    }
  }

  private refresh(connectionId: string, user: string, idp: Idp, refreshToken: string): Promise<OIDCResponse> {
    const key = keyOf(connectionId, user)
    const running = this.refreshing.get(key)
    if (running) return running
    const run = (async () => {
      const md = await this.metadata.get(idp.issuer)
      const doc = await this.post(md.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: idp.clientId,
      })
      const identity = this.checkIdToken(doc, idp, null)
      const before = this.deps.tokens.get(connectionId, user)
      const tokens = this.tokensFrom(doc, { refreshToken, identity: before?.identity }, identity)
      this.deps.tokens.put(connectionId, user, idp, tokens)
      return this.response(tokens)
    })().finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, run)
    return run
  }

  /**
   * The driver's OIDC_HUMAN_CALLBACK for one connection and person. It never starts a sign-in (the
   * person's browser does): a token, a refreshed token, or OIDC_SIGN_IN_NEEDED.
   */
  callback(connectionId: string, user: string): OIDCCallbackFunction {
    return async (params) => {
      const idp = this.remember(connectionId, params.idpInfo)
      if (!idp) throw new Error(OIDC_SIGN_IN_NEEDED)
      const stored = this.deps.tokens.get(connectionId, user)
      // Abuse case: tokens of another identity provider (or client) are never sent to this server.
      const same = stored && stored.issuer === idp.issuer && stored.clientId === idp.clientId
      // Security review Minor 2: the driver's refresh token came from what is stored; it goes only
      // to the identity provider (and client) that issued it.
      if (params.refreshToken && same) {
        try {
          return await this.refresh(connectionId, user, idp, params.refreshToken)
        } catch {
          // The driver's copy is stale or refused: what is stored is tried next.
        }
      }
      if (same && stored) {
        if (!stored.expiresAt || stored.expiresAt - this.deps.now() > EARLY_MS) return this.response(stored)
        if (stored.refreshToken) {
          try {
            return await this.refresh(connectionId, user, idp, stored.refreshToken)
          } catch (e) {
            const code = (e as { code?: string }).code
            this.deps.warn?.(
              { connectionId, user, reason: (e as OidcFlowError).reason ?? 'error', code },
              'OIDC: a refresh failed',
            )
            // Refused for good (invalid_grant): the sign-in is over; anything else may pass.
            if (code === 'invalid_grant') {
              // Unless another client of theirs refreshed meanwhile (a rotated token is stored).
              const now = this.deps.tokens.get(connectionId, user)?.refreshToken
              if (now && safeEqual(now, stored.refreshToken)) this.deps.tokens.delete(connectionId, user)
            }
          }
        }
      }
      throw new Error(OIDC_SIGN_IN_NEEDED)
    }
  }

  /** The browser's sign-in: where to send it, and the value its own cookie must bring back. */
  async startCode(input: {
    connectionId: string
    user: string
    redirectUri: string
    returnTo: string
  }): Promise<{ authorizeUrl: string; binding: string; flowId: string; issuer: string }> {
    const idp = await this.idpFor(input.connectionId, input.user)
    const md = await this.metadata.get(idp.issuer)
    this.prune()
    if (this.codeFlows.size >= MAX_CODE_FLOWS)
      throw new OidcFlowError('oidc_busy', 'Too many sign-ins are waiting; try again in a few minutes')
    // At most five waiting per person: an older one is dropped.
    const mine = [...this.codeFlows].filter(([, f]) => f.user === input.user)
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - 4))) this.codeFlows.delete(hash)
    const state = random()
    const nonce = random()
    const verifier = random()
    const binding = random()
    this.codeFlows.set(sha256(state).toString('base64url'), {
      connectionId: input.connectionId,
      user: input.user,
      verifier,
      nonce,
      redirectUri: input.redirectUri,
      idp,
      tokenEndpoint: md.tokenEndpoint,
      bindingHash: sha256(binding),
      returnTo: input.returnTo,
      expiresAt: this.deps.now() + FLOW_MS,
    })
    const url = new URL(md.authorizationEndpoint)
    const scopes = [...new Set(['openid', 'offline_access', ...idp.requestScopes])]
    url.searchParams.set('client_id', idp.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    return { authorizeUrl: url.href, binding, flowId: flowIdOf(state), issuer: idp.issuer }
  }

  /** The identity provider sent the browser back: the code is exchanged here, never shown. */
  async finishCode(input: {
    state: string
    code?: string | undefined
    error?: string | undefined
    binding: string | undefined
  }): Promise<{ connectionId: string; user: string; returnTo: string; identity?: OidcIdentity }> {
    const hash = sha256(input.state).toString('base64url')
    const flow = this.codeFlows.get(hash)
    // One use, whatever happens next.
    this.codeFlows.delete(hash)
    if (!flow || flow.expiresAt <= this.deps.now())
      throw new OidcFlowError('oidc_state', 'This sign-in is unknown or expired: start it again')
    // Abuse case (login CSRF): only the browser that started the sign-in may finish it.
    const bound = input.binding ? sha256(input.binding) : null
    if (!bound || !timingSafeEqual(bound, flow.bindingHash))
      throw new OidcFlowError(
        'oidc_state',
        'This sign-in was started in another browser: start it again here',
      )
    if (input.error || !input.code)
      throw new OidcFlowError(
        'oidc_denied',
        `The identity provider did not sign you in: ${errorCode(input.error)}`,
      )
    const doc = await this.post(flow.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: flow.redirectUri,
      client_id: flow.idp.clientId,
      code_verifier: flow.verifier,
    })
    const identity = this.checkIdToken(doc, flow.idp, flow.nonce)
    this.deps.tokens.put(flow.connectionId, flow.user, flow.idp, this.tokensFrom(doc, undefined, identity))
    await this.deps.invalidate(flow.connectionId, flow.user)
    return {
      connectionId: flow.connectionId,
      user: flow.user,
      returnTo: flow.returnTo,
      ...(identity ? { identity } : {}),
    }
  }

  /** The device flow: a code the person enters at the identity provider; the server polls. */
  async startDevice(input: {
    connectionId: string
    user: string
  }): Promise<NonNullable<OidcStatus['device']>> {
    const idp = await this.idpFor(input.connectionId, input.user)
    const md: IssuerMetadata = await this.metadata.get(idp.issuer)
    if (!md.deviceAuthorizationEndpoint)
      throw new OidcFlowError(
        'oidc_device_unsupported',
        'The identity provider does not offer sign-in with a code',
      )
    this.prune()
    const key = keyOf(input.connectionId, input.user)
    const now0 = this.deps.now()
    const waiting = (f: DeviceFlow) => f.state === 'pending' && f.expiresAt > now0
    const theirs = [...this.deviceFlows].filter(([k, f]) => k !== key && f.user === input.user && waiting(f))
    if (
      (!this.deviceFlows.has(key) && this.deviceFlows.size >= MAX_DEVICE_FLOWS) ||
      theirs.length >= MAX_DEVICE_FLOWS_PER_USER
    )
      throw new OidcFlowError('oidc_busy', 'Too many sign-ins are waiting; try again in a few minutes')
    const doc = await this.post(md.deviceAuthorizationEndpoint, {
      client_id: idp.clientId,
      scope: [...new Set(['openid', 'offline_access', ...idp.requestScopes])].join(' '),
    })
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined)
    const deviceCode = text(doc.device_code, 4096)
    const userCode = text(doc.user_code, 64)
    const verificationUri = text(doc.verification_uri, 2048)
    const complete = text(doc.verification_uri_complete, 2048)
    if (!deviceCode || !userCode || !verificationUri)
      throw new OidcFlowError('oidc_token', 'The identity provider’s answer is incomplete')
    // The person is sent there: https only (or the issuer's own listed http host).
    const base = issuerUrl(idp.issuer)
    const safe = (u: string | undefined) => {
      if (!u) return undefined
      try {
        const url = new URL(u)
        const httpOk = base.protocol === 'http:' && url.protocol === 'http:' && url.host === base.host
        return (url.protocol === 'https:' || httpOk) && !url.username && !url.password ? url.href : undefined
      } catch {
        return undefined
      }
    }
    const verify = safe(verificationUri)
    if (!verify)
      throw new OidcFlowError('oidc_token', 'The identity provider’s sign-in page is not an https address')
    const expiresIn = Number(doc.expires_in)
    const interval = Number(doc.interval)
    const now = this.deps.now()
    const intervalMs = Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 60) * 1000 : 5_000
    const flow: DeviceFlow = {
      connectionId: input.connectionId,
      user: input.user,
      deviceCode,
      userCode,
      verificationUri: verify,
      ...(safe(complete) ? { verificationUriComplete: safe(complete)! } : {}),
      expiresAt:
        now +
        (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn * 1000, DEVICE_MAX_MS) : FLOW_MS),
      intervalMs,
      nextPollAt: now + intervalMs,
      state: 'pending',
      idp,
      tokenEndpoint: md.tokenEndpoint,
    }
    this.deviceFlows.set(key, flow)
    return this.deviceView(flow)
  }

  private deviceView(f: DeviceFlow): NonNullable<OidcStatus['device']> {
    return {
      userCode: f.userCode,
      verificationUri: f.verificationUri,
      ...(f.verificationUriComplete ? { verificationUriComplete: f.verificationUriComplete } : {}),
      expiresAt: f.expiresAt,
      state: f.state,
      issuer: f.idp.issuer,
    }
  }

  status(connectionId: string, user: string): OidcStatus {
    const stored = this.deps.tokens.get(connectionId, user)
    const usable =
      !!stored && (!!stored.refreshToken || !stored.expiresAt || stored.expiresAt > this.deps.now())
    const device = this.deviceFlows.get(keyOf(connectionId, user))
    return {
      signedIn: usable,
      ...(stored ? { issuer: stored.issuer, expiresAt: stored.expiresAt ?? null } : {}),
      ...(device ? { device: this.deviceView(device) } : {}),
    }
  }

  /** The status, after asking the identity provider about a waiting device sign-in when it is due. */
  async poll(connectionId: string, user: string): Promise<OidcStatus> {
    const f = this.deviceFlows.get(keyOf(connectionId, user))
    const now = this.deps.now()
    let completed: OidcIdentity | undefined
    if (f && f.state === 'pending') {
      if (f.expiresAt <= now) f.state = 'expired'
      else if (now >= f.nextPollAt) {
        f.nextPollAt = now + f.intervalMs
        try {
          const doc = await this.post(f.tokenEndpoint, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: f.deviceCode,
            client_id: f.idp.clientId,
          })
          const identity = this.checkIdToken(doc, f.idp, null)
          this.deps.tokens.put(connectionId, user, f.idp, this.tokensFrom(doc, undefined, identity))
          f.state = 'done'
          // Security review I6: said once, so the route can record who signed in.
          completed = identity ?? { subject: '' }
          await this.deps.invalidate(connectionId, user)
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code === 'authorization_pending') {
            // Still waiting for the person.
          } else if (code === 'slow_down') f.intervalMs += 5_000
          else if (code === 'access_denied') f.state = 'denied'
          else if (code === 'expired_token') f.state = 'expired'
          else f.state = 'failed'
        }
      }
    }
    const status = this.status(connectionId, user)
    return completed ? { ...status, completed } : status
  }

  /** Signs a person out of a connection: tokens dropped, revoked at the provider, client closed. */
  async signOut(connectionId: string, user: string): Promise<boolean> {
    const stored = this.deps.tokens.get(connectionId, user)
    const removed = this.deps.tokens.delete(connectionId, user)
    this.deviceFlows.delete(keyOf(connectionId, user))
    await this.deps.invalidate(connectionId, user)
    if (stored) await this.revoke(stored.issuer, stored.clientId, stored)
    return removed
  }

  /** RFC 7009, best effort: the refresh token first (it revokes the grant at most providers). */
  private async revoke(issuer: string, clientId: string, tokens: OidcTokens): Promise<void> {
    try {
      const md = await this.metadata.get(issuer)
      if (!md.revocationEndpoint) return
      for (const [token, hint] of [
        [tokens.refreshToken, 'refresh_token'],
        [tokens.accessToken, 'access_token'],
      ] as const) {
        if (token)
          await this.post(md.revocationEndpoint, { token, token_type_hint: hint, client_id: clientId }).catch(
            () => undefined,
          )
      }
    } catch {
      this.deps.warn?.({ issuer }, 'OIDC: the identity provider could not be asked to revoke a sign-in')
    }
  }

  /**
   * A connection changed or went: its sign-ins and what is known of its identity provider. Security
   * review Minor 3: each sign-in is revoked at its provider too (best effort), not merely forgotten.
   */
  async forgetConnection(connectionId: string): Promise<void> {
    const dropped = this.deps.tokens.records({ connectionId })
    this.deps.tokens.deleteConnection(connectionId)
    this.idps.delete(connectionId)
    for (const [hash, f] of this.codeFlows) if (f.connectionId === connectionId) this.codeFlows.delete(hash)
    for (const [key, f] of this.deviceFlows) if (f.connectionId === connectionId) this.deviceFlows.delete(key)
    await Promise.all(dropped.map((r) => this.revoke(r.issuer, r.clientId, r)))
  }

  /** Who is signed in on a connection (no tokens), and as whom at the identity provider. */
  people(
    connectionId: string,
  ): Array<{ user: string; issuer: string; updatedAt: number; identity?: OidcIdentity }> {
    return this.deps.tokens.people(connectionId)
  }

  /** A person was deleted: their sign-ins on every connection, revoked at the provider (Minor 3). */
  async forgetUser(user: string): Promise<void> {
    const dropped = this.deps.tokens.records({ user })
    this.deps.tokens.deleteUser(user)
    for (const [hash, f] of this.codeFlows) if (f.user === user) this.codeFlows.delete(hash)
    for (const [key, f] of this.deviceFlows) if (f.user === user) this.deviceFlows.delete(key)
    await Promise.all(dropped.map((r) => this.revoke(r.issuer, r.clientId, r)))
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [hash, f] of this.codeFlows) if (f.expiresAt <= now) this.codeFlows.delete(hash)
    for (const [key, f] of this.deviceFlows) if (f.expiresAt + FLOW_MS <= now) this.deviceFlows.delete(key)
  }
}
