// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startHttpsServer } from './https-server'

/**
 * W7: a test identity provider (plain HTTP on 127.0.0.1, reached through an egress that lists
 * 127.0.0.1/32). It does what a real one does with the flows Mongo Manager uses — discovery,
 * authorization code with PKCE, refresh, device authorization, revocation — and records what it
 * was sent, so tests can check what reached it. Its ID tokens are unsigned (the token endpoint is
 * reached directly over the egress guard, OIDC Core 3.1.3.7).
 */
export interface IdpOptions {
  /** The issuer the metadata names (another one than its own address: a mix-up). */
  issuerOverride?: string
  /** The nonce its ID tokens carry instead of the one asked for. */
  nonceOverride?: string
  /** Leaves S256 out of code_challenge_methods_supported. */
  noS256?: boolean
  /** Leaves the device endpoint out. */
  noDevice?: boolean
  accessTtl?: number
  /** The provider's clock (ms): the tests' own, so ID tokens expire when their clock says. */
  clock?: () => number
}

interface Code {
  clientId: string
  redirectUri: string
  challenge: string
  nonce: string
  scope: string
}

export async function startIdp(opts: IdpOptions = {}) {
  const codes = new Map<string, Code>()
  const refreshTokens = new Map<string, string>()
  const devices = new Map<
    string,
    { approved: boolean; denied: boolean; userCode: string; clientId: string }
  >()
  const requests: Array<{ path: string; body: Record<string, string> }> = []
  const revoked: string[] = []
  let issued = 0
  let issuer = ''

  const read = async (req: IncomingMessage): Promise<Record<string, string>> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const tokens = (clientId: string, nonce: string | null) => {
    issued++
    const access = `at-${issued}-${randomBytes(6).toString('hex')}`
    const refresh = `rt-${issued}-${randomBytes(6).toString('hex')}`
    refreshTokens.set(refresh, clientId)
    const now = Math.floor((opts.clock?.() ?? Date.now()) / 1000)
    const claims = {
      iss: issuer,
      aud: clientId,
      sub: 'ana',
      preferred_username: 'ana@corp.example',
      email: 'ana.mail@corp.example',
      exp: now + 3600,
      iat: now,
      ...(nonce !== null ? { nonce: opts.nonceOverride ?? nonce } : {}),
    }
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: opts.accessTtl ?? 3600,
      id_token: `${b64({ alg: 'none' })}.${b64(claims)}.`,
    }
  }

  const server = await startHttpsServer(
    async (req, res) => {
      const url = new URL(req.url ?? '/', issuer)
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: opts.issuerOverride ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          revocation_endpoint: `${issuer}/revoke`,
          ...(opts.noDevice ? {} : { device_authorization_endpoint: `${issuer}/device` }),
          code_challenge_methods_supported: opts.noS256 ? ['plain'] : ['S256'],
        })
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'not_found' })
      const body = await read(req)
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/revoke') {
        revoked.push(body.token ?? '')
        return json(res, 200, {})
      }
      if (url.pathname === '/device') {
        const deviceCode = randomBytes(8).toString('hex')
        const userCode = 'WDJB-MJHT'
        devices.set(deviceCode, { approved: false, denied: false, userCode, clientId: body.client_id ?? '' })
        return json(res, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${issuer}/activate`,
          verification_uri_complete: `${issuer}/activate?user_code=${userCode}`,
          expires_in: 600,
          interval: 5,
        })
      }
      if (url.pathname !== '/token') return json(res, 404, { error: 'not_found' })
      if (body.grant_type === 'authorization_code') {
        const code = codes.get(body.code ?? '')
        codes.delete(body.code ?? '')
        if (!code) return json(res, 400, { error: 'invalid_grant' })
        const challenge = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url')
        if (
          challenge !== code.challenge ||
          body.redirect_uri !== code.redirectUri ||
          body.client_id !== code.clientId
        )
          return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, tokens(code.clientId, code.nonce))
      }
      if (body.grant_type === 'refresh_token') {
        const clientId = refreshTokens.get(body.refresh_token ?? '')
        if (!clientId || clientId !== body.client_id) return json(res, 400, { error: 'invalid_grant' })
        refreshTokens.delete(body.refresh_token ?? '')
        return json(res, 200, tokens(clientId, null))
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = devices.get(body.device_code ?? '')
        if (!d) return json(res, 400, { error: 'expired_token' })
        if (d.denied) return json(res, 400, { error: 'access_denied' })
        if (!d.approved) return json(res, 400, { error: 'authorization_pending' })
        devices.delete(body.device_code ?? '')
        return json(res, 200, tokens(d.clientId, null))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    },
    { plain: true },
  )
  issuer = server.url

  return {
    issuer,
    close: server.close,
    requests,
    revoked,
    /** The person signs in at the authorize URL: the code the IdP sends back with the state. */
    authorize(authorizeUrl: string): { code: string; state: string; redirectUri: string } {
      const u = new URL(authorizeUrl)
      const p = u.searchParams
      if (u.origin !== issuer || u.pathname !== '/authorize') throw new Error(`not this IdP: ${authorizeUrl}`)
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256')
        throw new Error('not a PKCE code request')
      const code = randomBytes(8).toString('hex')
      codes.set(code, {
        clientId: p.get('client_id') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        challenge: p.get('code_challenge') ?? '',
        nonce: p.get('nonce') ?? '',
        scope: p.get('scope') ?? '',
      })
      return { code, state: p.get('state') ?? '', redirectUri: p.get('redirect_uri') ?? '' }
    },
    approveDevice(userCode: string, approve = true) {
      for (const d of devices.values())
        if (d.userCode === userCode) {
          d.approved = approve
          d.denied = !approve
        }
    },
    /** Every token it ever issued, so a test can look for one where it must not be. */
    issuedCount: () => issued,
  }
}
export type Idp = Awaited<ReturnType<typeof startIdp>>
