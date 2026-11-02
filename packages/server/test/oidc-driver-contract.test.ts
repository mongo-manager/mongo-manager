import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BSON, Binary } from 'bson'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { openStore, type Store } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'
import { ConnectionRepo } from '../src/connections/repo'
import { createEgress } from '../src/net/egress'
import { OidcTokenRepo } from '../src/oidc/tokens'
import { OidcBroker } from '../src/oidc/broker'
import { classifyError } from '../src/connections/errors'
import { startIdp, type Idp } from './support/oidc-idp'

/**
 * W7: the callback contract, checked against the MongoDB driver's own human workflow (its internal
 * module, with a fake server connection). MONGODB-OIDC itself needs MongoDB Enterprise or Atlas, so
 * no real server signs in here; what is verified is that the driver gives the broker the identity
 * provider the server named, sends the server the token the broker returns, and asks the broker to
 * refresh with the refresh token it was given when the server refuses an expired token.
 */
const require = createRequire(import.meta.url)
const { HumanCallbackWorkflow } =
  require('mongodb/lib/cmap/auth/mongodb_oidc/human_callback_workflow.js') as {
    HumanCallbackWorkflow: new (
      cache: unknown,
      callback: unknown,
    ) => {
      execute(connection: unknown, credentials: unknown): Promise<void>
      reauthenticate(connection: unknown, credentials: unknown): Promise<void>
    }
  }
const { TokenCache } = require('mongodb/lib/cmap/auth/mongodb_oidc/token_cache.js') as {
  TokenCache: new () => unknown
}

/** A server that names an identity provider, takes a token once, and may refuse it as expired. */
function fakeServer(idpInfo: { issuer: string; clientId: string }) {
  const jwts: string[] = []
  let refuseNext = false
  const connection: Record<string, unknown> = {
    async command(_ns: unknown, cmd: Record<string, unknown>) {
      const payload = BSON.deserialize((cmd.payload as Binary).buffer)
      if (cmd.saslStart && payload.jwt === undefined)
        return { ok: 1, done: false, conversationId: 1, payload: new Binary(BSON.serialize(idpInfo)) }
      jwts.push(String(payload.jwt))
      if (refuseNext) {
        refuseNext = false
        throw Object.assign(new (require('mongodb').MongoServerError)({ code: 18, errmsg: 'expired' }), {})
      }
      return { ok: 1, done: true }
    },
  }
  return {
    connection,
    jwts,
    refuseOnce: () => {
      refuseNext = true
    },
  }
}

let idp: Idp
beforeAll(async () => {
  idp = await startIdp()
})
afterAll(async () => idp?.close())

let dir: string
let store: Store
let connectionId: string
const box = createSecretBox(randomBytes(32))
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-oidc-driver-'))
  store = await openStore(dir)
  connectionId = new ConnectionRepo(store.db, box, Date.now).create(
    {
      name: 'oidc',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: 'localhost' }],
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

describe('W7: the driver’s human OIDC workflow and the broker', () => {
  it('passes the server’s identity provider to the broker, which asks the person to sign in', async () => {
    const info = { issuer: idp.issuer, clientId: 'mm-client' }
    const broker = new OidcBroker({
      egress: createEgress({ networks: ['127.0.0.1/32'] }),
      tokens: new OidcTokenRepo(store.db, box, Date.now),
      now: Date.now,
      invalidate: async () => undefined,
      probe: async () => info,
    })
    const server = fakeServer(info)
    const workflow = new HumanCallbackWorkflow(new TokenCache(), broker.callback(connectionId, 'local'))
    const err = await workflow
      .execute(server.connection, { source: '$external', mechanismProperties: {} })
      .catch((e) => e)
    expect(classifyError(err).kind).toBe('oidc')
    // What the server named is what a sign-in starts from (no second connection attempt needed).
    const start = await broker.startCode({
      connectionId,
      user: 'local',
      redirectUri: 'http://localhost:4321/oidc/callback',
      returnTo: '/',
    })
    expect(new URL(start.authorizeUrl).searchParams.get('client_id')).toBe('mm-client')
    expect(server.jwts).toEqual([])
  })

  it('sends the server the broker’s token, then refreshes it when the server refuses it', async () => {
    const info = { issuer: idp.issuer, clientId: 'mm-client' }
    const broker = new OidcBroker({
      egress: createEgress({ networks: ['127.0.0.1/32'] }),
      tokens: new OidcTokenRepo(store.db, box, Date.now),
      now: Date.now,
      invalidate: async () => undefined,
      probe: async () => info,
    })
    const start = await broker.startCode({
      connectionId,
      user: 'local',
      redirectUri: 'http://localhost:4321/oidc/callback',
      returnTo: '/',
    })
    const back = idp.authorize(start.authorizeUrl)
    await broker.finishCode({ state: back.state, code: back.code, binding: start.binding })

    const server = fakeServer(info)
    const workflow = new HumanCallbackWorkflow(new TokenCache(), broker.callback(connectionId, 'local'))
    const credentials = { source: '$external', mechanismProperties: {} }
    await workflow.execute(server.connection, credentials)
    expect(server.jwts).toHaveLength(1)
    expect(server.jwts[0]).toMatch(/^at-/)
    const before = idp.requests.filter((r) => r.body.grant_type === 'refresh_token').length

    // The server says the token expired: the driver drops it and asks again with the refresh token.
    server.refuseOnce()
    ;(server.connection as { accessToken?: string }).accessToken = server.jwts[0]
    await workflow.reauthenticate(server.connection, credentials)
    expect(idp.requests.filter((r) => r.body.grant_type === 'refresh_token').length).toBe(before + 1)
    const last = server.jwts.at(-1)!
    expect(last).toMatch(/^at-/)
    expect(last).not.toBe(server.jwts[0])
  })
})
