import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IdPInfo, OIDCCallbackParams } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { openStore, type Store } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { createEgress } from '../src/net/egress'
import { OidcTokenRepo } from '../src/oidc/tokens'
import { OidcBroker, OidcFlowError } from '../src/oidc/broker'
import { OIDC_SIGN_IN_NEEDED } from '../src/connections/errors'
import { startIdp, type Idp } from './support/oidc-idp'

let idp: Idp
let mixUp: Idp
let badNonce: Idp
let noS256: Idp
let second: Idp
beforeAll(async () => {
  const tick = () => clock.now
  ;[idp, mixUp, badNonce, noS256, second] = await Promise.all([
    startIdp({ clock: tick }),
    startIdp({ clock: tick, issuerOverride: 'https://login.evil.example' }),
    startIdp({ clock: tick, nonceOverride: 'someone-elses-nonce' }),
    startIdp({ clock: tick, noS256: true }),
    startIdp({ clock: tick }),
  ])
})
afterAll(async () => Promise.all([idp, mixUp, badNonce, noS256, second].map((i) => i?.close())))

let dir: string
let store: Store
let connectionId: string
const clock = { now: Date.now() }
const box = createSecretBox(randomBytes(32))
const egress = createEgress({ networks: ['127.0.0.1/32'], networksSetting: 'MM_OIDC_PRIVATE_NETWORKS' })
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-oidc-'))
  store = await openStore(dir)
  clock.now = Date.now()
  connectionId = new ConnectionRepo(store.db, box, () => clock.now).create(
    {
      name: 'oidc',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: 'cluster0.x.mongodb.net' }],
        scheme: 'mongodb+srv',
        auth: { mechanism: 'MONGODB-OIDC' },
      }),
    },
    null,
  ).id
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const REDIRECT = 'http://localhost:4321/oidc/callback'
function brokerFor(i: Idp, over: Partial<ConstructorParameters<typeof OidcBroker>[0]> = {}) {
  const tokens = new OidcTokenRepo(store.db, box, () => clock.now)
  const invalidate = vi.fn(async () => undefined)
  const warnings: string[] = []
  const info: IdPInfo = { issuer: i.issuer, clientId: 'mm-client', requestScopes: ['api://mongo/db.read'] }
  const probe = vi.fn(async () => info)
  const broker = new OidcBroker({
    egress,
    tokens,
    now: () => clock.now,
    invalidate,
    probe,
    warn: (fields, message) => warnings.push(`${message} ${JSON.stringify(fields)}`),
    ...over,
  })
  return { broker, tokens, invalidate, probe, warnings, info }
}
const params = (info: IdPInfo, refreshToken?: string): OIDCCallbackParams => ({
  version: 1,
  timeoutContext: new AbortController().signal,
  idpInfo: info,
  ...(refreshToken ? { refreshToken } : {}),
})

async function signIn(b: ReturnType<typeof brokerFor>, i: Idp, user = 'ana') {
  const start = await b.broker.startCode({ connectionId, user, redirectUri: REDIRECT, returnTo: '/' })
  const back = i.authorize(start.authorizeUrl)
  return b.broker.finishCode({ state: back.state, code: back.code, binding: start.binding })
}

describe('W7: authorization code with PKCE', () => {
  it('asks the issuer the MongoDB server named, with S256, a state, a nonce and the scopes', async () => {
    const b = brokerFor(idp)
    const start = await b.broker.startCode({
      connectionId,
      user: 'ana',
      redirectUri: REDIRECT,
      returnTo: '/',
    })
    const u = new URL(start.authorizeUrl)
    expect(u.origin).toBe(idp.issuer)
    const p = u.searchParams
    expect(p.get('client_id')).toBe('mm-client')
    expect(p.get('redirect_uri')).toBe(REDIRECT)
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('scope')!.split(' ').sort()).toEqual(['api://mongo/db.read', 'offline_access', 'openid'])
    // The verifier never leaves the server.
    expect(start.authorizeUrl).not.toContain('code_verifier')
  })

  it('stores the tokens sealed, for that person and connection only, and closes their old client', async () => {
    const b = brokerFor(idp)
    const done = await signIn(b, idp)
    expect(done).toMatchObject({ connectionId, user: 'ana', returnTo: '/' })
    expect(b.invalidate).toHaveBeenCalledWith(connectionId, 'ana')
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM oidc_tokens').all())
    // The tokens' own shape (at-<n>-<12 hex>): sealed text is base64url, and "rt-0" alone turned up
    // in it by chance (CI fixes, a 6.0 run).
    expect(raw).not.toMatch(/[ar]t-\d+-[0-9a-f]{12}/)
    expect(b.broker.status(connectionId, 'ana')).toMatchObject({ signedIn: true, issuer: idp.issuer })
    expect(b.broker.status(connectionId, 'bob')).toMatchObject({ signedIn: false })
  })

  it('takes a state once, and not after ten minutes', async () => {
    const b = brokerFor(idp)
    const start = await b.broker.startCode({
      connectionId,
      user: 'ana',
      redirectUri: REDIRECT,
      returnTo: '/',
    })
    const back = idp.authorize(start.authorizeUrl)
    await b.broker.finishCode({ state: back.state, code: back.code, binding: start.binding })
    await expect(
      b.broker.finishCode({ state: back.state, code: back.code, binding: start.binding }),
    ).rejects.toMatchObject({ reason: 'oidc_state' })
    const late = await b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' })
    const lateBack = idp.authorize(late.authorizeUrl)
    clock.now += 11 * 60_000
    await expect(
      b.broker.finishCode({ state: lateBack.state, code: lateBack.code, binding: late.binding }),
    ).rejects.toMatchObject({ reason: 'oidc_state' })
  })

  // Abuse case (login CSRF): someone else's browser finishing a flow an attacker started would put
  // the victim's tokens on the attacker's account. The browser that started it must finish it.
  it('refuses a flow finished in another browser than the one that started it', async () => {
    const b = brokerFor(idp)
    const start = await b.broker.startCode({
      connectionId,
      user: 'eve',
      redirectUri: REDIRECT,
      returnTo: '/',
    })
    const back = idp.authorize(start.authorizeUrl)
    await expect(
      b.broker.finishCode({ state: back.state, code: back.code, binding: 'other-browser' }),
    ).rejects.toBeInstanceOf(OidcFlowError)
    await expect(
      b.broker.finishCode({ state: back.state, code: back.code, binding: undefined }),
    ).rejects.toBeInstanceOf(OidcFlowError)
    expect(b.broker.status(connectionId, 'eve').signedIn).toBe(false)
  })

  it('refuses an identity provider whose metadata names another issuer (mix-up)', async () => {
    const b = brokerFor(mixUp)
    await expect(
      b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' }),
    ).rejects.toMatchObject({ reason: 'oidc_issuer' })
  })

  it('refuses an ID token with another nonce, and keeps nothing', async () => {
    const b = brokerFor(badNonce)
    await expect(signIn(b, badNonce)).rejects.toMatchObject({ reason: 'oidc_id_token' })
    expect(b.broker.status(connectionId, 'ana').signedIn).toBe(false)
  })

  it('refuses an identity provider without S256', async () => {
    const b = brokerFor(noS256)
    await expect(
      b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' }),
    ).rejects.toMatchObject({ reason: 'oidc_pkce' })
  })

  it('says what the identity provider refused, by its error code only', async () => {
    const b = brokerFor(idp)
    const start = await b.broker.startCode({
      connectionId,
      user: 'ana',
      redirectUri: REDIRECT,
      returnTo: '/',
    })
    const back = idp.authorize(start.authorizeUrl)
    await expect(
      b.broker.finishCode({ state: back.state, error: 'access_denied', binding: start.binding }),
    ).rejects.toMatchObject({ reason: 'oidc_denied' })
  })
})

describe('W7: the issuer goes through the egress guard', () => {
  it('refuses an issuer that is not a plain https (or listed http) address', async () => {
    for (const issuer of [
      'ftp://idp.example',
      'https://u:p@idp.example',
      'http://169.254.169.254',
      'not a url',
    ]) {
      const b = brokerFor(idp, { probe: async () => ({ issuer, clientId: 'c' }) })
      await expect(
        b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' }),
        issuer,
      ).rejects.toBeInstanceOf(OidcFlowError)
    }
  })

  it('refuses an issuer on a private address that is not listed', async () => {
    const strict = createEgress({ networks: [], networksSetting: 'MM_OIDC_PRIVATE_NETWORKS' })
    const b = brokerFor(idp, { egress: strict })
    await expect(
      b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' }),
    ).rejects.toMatchObject({ reason: 'oidc_issuer_unreachable' })
  })
})

describe('W7: the driver’s callback gets a person’s own tokens, refreshed, never another’s', () => {
  it('gives the stored token to its owner only', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const got = await b.broker.callback(connectionId, 'ana')(params(b.info))
    expect(got.accessToken).toMatch(/^at-/)
    expect(got.refreshToken).toMatch(/^rt-/)
    await expect(b.broker.callback(connectionId, 'bob')(params(b.info))).rejects.toThrow(OIDC_SIGN_IN_NEEDED)
  })

  // Abuse case: a server that now names another identity provider gets no token of the old one.
  it('sends nothing when the server names another issuer or client than the tokens came from', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const other = { issuer: 'https://login.other.example', clientId: 'mm-client' }
    await expect(b.broker.callback(connectionId, 'ana')(params(other))).rejects.toThrow(OIDC_SIGN_IN_NEEDED)
    await expect(
      b.broker.callback(connectionId, 'ana')(params({ ...b.info, clientId: 'other-client' })),
    ).rejects.toThrow(OIDC_SIGN_IN_NEEDED)
  })

  it('refreshes with the refresh token the driver hands back, and keeps the new tokens', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const first = await b.broker.callback(connectionId, 'ana')(params(b.info))
    const second = await b.broker.callback(connectionId, 'ana')(params(b.info, first.refreshToken))
    expect(second.accessToken).not.toBe(first.accessToken)
    const third = await b.broker.callback(connectionId, 'ana')(params(b.info))
    expect(third.accessToken).toBe(second.accessToken)
  })

  it('refreshes an expired stored token on its own', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const first = await b.broker.callback(connectionId, 'ana')(params(b.info))
    clock.now += 2 * 3600_000
    const next = await b.broker.callback(connectionId, 'ana')(params(b.info))
    expect(next.accessToken).not.toBe(first.accessToken)
  })

  it('forgets tokens whose refresh the identity provider refused', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    // A refresh token the provider does not take falls back to the stored, still valid token.
    await expect(b.broker.callback(connectionId, 'ana')(params(b.info, 'rt-forged'))).resolves.toBeDefined()
    clock.now += 2 * 3600_000
    // An expired token whose refresh token is refused: the sign-in goes, the person signs in again.
    store.db
      .prepare('UPDATE oidc_tokens SET sealed = ? WHERE user_key = ?')
      .run(
        box.seal(
          JSON.stringify({ accessToken: 'x', refreshToken: 'rt-stale', expiresAt: 1 }),
          `oidc-token:${connectionId}:ana`,
        ),
        'ana',
      )
    await expect(b.broker.callback(connectionId, 'ana')(params(b.info))).rejects.toThrow(OIDC_SIGN_IN_NEEDED)
    expect(b.broker.status(connectionId, 'ana').signedIn).toBe(false)
  })
})

describe('W7: device authorization, the fallback', () => {
  it('shows a code to enter at the identity provider and signs in once it is approved', async () => {
    const b = brokerFor(idp)
    const start = await b.broker.startDevice({ connectionId, user: 'ana' })
    expect(start.userCode).toBe('WDJB-MJHT')
    expect(start.verificationUri).toBe(`${idp.issuer}/activate`)
    // The device code itself never leaves the server.
    expect(JSON.stringify(start)).not.toMatch(/device_code|deviceCode/)
    expect((await b.broker.poll(connectionId, 'ana')).device?.state).toBe('pending')
    idp.approveDevice('WDJB-MJHT')
    clock.now += 6_000
    const status = await b.broker.poll(connectionId, 'ana')
    expect(status.signedIn).toBe(true)
    expect(b.invalidate).toHaveBeenCalledWith(connectionId, 'ana')
  })

  it('polls no faster than the identity provider asks', async () => {
    const b = brokerFor(idp)
    await b.broker.startDevice({ connectionId, user: 'ana' })
    const before = idp.requests.filter((r) => r.path === '/token').length
    await b.broker.poll(connectionId, 'ana')
    await b.broker.poll(connectionId, 'ana')
    await b.broker.poll(connectionId, 'ana')
    expect(idp.requests.filter((r) => r.path === '/token').length - before).toBeLessThanOrEqual(1)
  })

  it('ends a denied sign-in', async () => {
    const b = brokerFor(idp)
    await b.broker.startDevice({ connectionId, user: 'ana' })
    idp.approveDevice('WDJB-MJHT', false)
    clock.now += 6_000
    expect((await b.broker.poll(connectionId, 'ana')).device?.state).toBe('denied')
  })
})

describe('W7 security review: who signed in, which provider, how many waiting', () => {
  // I6: an administrator sees whose identity a person's sign-in carries (a shared IdP account, or
  // someone else's approved device code, shows here).
  it('keeps who signed in (subject and name from the ID token) with the sign-in, sealed', async () => {
    const b = brokerFor(idp)
    const done = await signIn(b, idp)
    expect(done.identity).toEqual({ subject: 'ana', name: 'ana@corp.example' })
    expect(b.broker.people(connectionId)).toEqual([
      expect.objectContaining({
        user: 'ana',
        issuer: idp.issuer,
        identity: { subject: 'ana', name: 'ana@corp.example' },
      }),
    ])
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM oidc_tokens').all())
    expect(raw).not.toContain('ana@corp.example')
  })

  it('says when a device sign-in completed, with whom', async () => {
    const b = brokerFor(idp)
    await b.broker.startDevice({ connectionId, user: 'ana' })
    idp.approveDevice('WDJB-MJHT')
    clock.now += 6_000
    const status = await b.broker.poll(connectionId, 'ana')
    expect(status.completed).toEqual({ subject: 'ana', name: 'ana@corp.example' })
    clock.now += 6_000
    expect((await b.broker.poll(connectionId, 'ana')).completed).toBeUndefined()
  })

  // I5, abuse case: the MongoDB server (or whoever answers in its place) names the identity provider.
  // An administrator who set the expected issuer gets no sign-in anywhere else.
  it('refuses an identity provider other than the one an administrator expects', async () => {
    const b = brokerFor(idp, { expectedIssuer: () => 'https://login.corp.example' })
    await expect(
      b.broker.startCode({ connectionId, user: 'ana', redirectUri: REDIRECT, returnTo: '/' }),
    ).rejects.toMatchObject({ reason: 'oidc_issuer_mismatch' })
    await expect(b.broker.startDevice({ connectionId, user: 'ana' })).rejects.toMatchObject({
      reason: 'oidc_issuer_mismatch',
    })
    await expect(b.broker.callback(connectionId, 'ana')(params(b.info))).rejects.toMatchObject({
      reason: 'oidc_issuer_mismatch',
    })
    const ok = brokerFor(idp, { expectedIssuer: () => `${idp.issuer}/` })
    const start = await ok.broker.startCode({
      connectionId,
      user: 'ana',
      redirectUri: REDIRECT,
      returnTo: '/',
    })
    expect(start.issuer).toBe(idp.issuer)
  })

  // Minor 2, abuse case: the driver hands back the refresh token it was given; a server that now
  // names another identity provider must not have it sent there.
  it('never sends a refresh token to an identity provider other than the one it came from', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const first = await b.broker.callback(connectionId, 'ana')(params(b.info))
    const before = second.requests.length
    const other: IdPInfo = { issuer: second.issuer, clientId: 'mm-client' }
    await expect(b.broker.callback(connectionId, 'ana')(params(other, first.refreshToken))).rejects.toThrow(
      OIDC_SIGN_IN_NEEDED,
    )
    expect(second.requests.slice(before).some((r) => r.path === '/token')).toBe(false)
  })

  // Minor 6: one person cannot hold the server's device sign-ins hostage across many connections.
  it('keeps at most a few device sign-ins waiting per person', async () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const ids = Array.from(
      { length: 4 },
      (_, n) =>
        repo.create(
          {
            name: `c${n}`,
            favorite: false,
            readOnly: false,
            settings: ConnectionSettingsSchema.parse({
              hosts: [{ host: 'cluster0.x.mongodb.net' }],
              scheme: 'mongodb+srv',
              auth: { mechanism: 'MONGODB-OIDC' },
            }),
          },
          null,
        ).id,
    )
    const b = brokerFor(idp)
    for (const id of ids.slice(0, 3)) await b.broker.startDevice({ connectionId: id, user: 'mallory' })
    await expect(b.broker.startDevice({ connectionId: ids[3]!, user: 'mallory' })).rejects.toMatchObject({
      reason: 'oidc_busy',
    })
    // Someone else still can.
    await expect(b.broker.startDevice({ connectionId: ids[3]!, user: 'ana' })).resolves.toBeDefined()
  })
})

describe('W7: signing out revokes', () => {
  it('drops the tokens, asks the identity provider to revoke them and closes the client', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    const { refreshToken } = await b.broker.callback(connectionId, 'ana')(params(b.info))
    b.invalidate.mockClear()
    await b.broker.signOut(connectionId, 'ana')
    expect(b.broker.status(connectionId, 'ana').signedIn).toBe(false)
    expect(idp.revoked).toContain(refreshToken)
    expect(b.invalidate).toHaveBeenCalledWith(connectionId, 'ana')
  })

  // Minor 3: a sign-in dropped because its connection changed or went, or its person was deleted,
  // is revoked at the identity provider too — not merely forgotten here.
  it('forgets a connection’s and a person’s tokens, and revokes them at the provider', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    await signIn(b, idp, 'bob')
    const ana = b.tokens.get(connectionId, 'ana')!.refreshToken
    const bob = b.tokens.get(connectionId, 'bob')!.refreshToken
    await b.broker.forgetUser('ana')
    expect(b.broker.status(connectionId, 'ana').signedIn).toBe(false)
    expect(b.broker.status(connectionId, 'bob').signedIn).toBe(true)
    expect(idp.revoked).toContain(ana)
    await b.broker.forgetConnection(connectionId)
    expect(b.broker.status(connectionId, 'bob').signedIn).toBe(false)
    expect(idp.revoked).toContain(bob)
  })

  it('never writes a token into what it logs', async () => {
    const b = brokerFor(idp)
    await signIn(b, idp, 'ana')
    clock.now += 2 * 3600_000
    store.db
      .prepare('UPDATE oidc_tokens SET sealed = ?')
      .run(
        box.seal(
          JSON.stringify({ accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: 1 }),
          `oidc-token:${connectionId}:ana`,
        ),
      )
    await expect(b.broker.callback(connectionId, 'ana')(params(b.info))).rejects.toThrow()
    expect(b.warnings.join('\n')).not.toMatch(/at-|rt-/)
  })
})
