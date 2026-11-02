import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { startIdp, type Idp } from './support/oidc-idp'
import type { IdPInfo } from 'mongodb'
import type { PartialConfig } from '../src/config'
import { bindingCookie } from '../src/routes/oidc'

/**
 * W7: MONGODB-OIDC sign-in through the HTTP API, end to end against a test identity provider. The
 * MongoDB side (which needs Enterprise or Atlas) is the broker's probe, replaced here by the IdP
 * information a server would name; oidc-driver-contract.test.ts checks the driver's side.
 */
let idp: Idp
beforeAll(async () => {
  idp = await startIdp()
})
afterAll(async () => idp?.close())

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const oidcSettings = ConnectionSettingsSchema.parse({
  hosts: [{ host: 'localhost', port: 27017 }],
  auth: { mechanism: 'MONGODB-OIDC' },
})

async function teamApp(over: Partial<PartialConfig> = {}) {
  const t = await makeApp({ auth: true, oidc: { privateNetworks: ['127.0.0.1/32'] }, ...over })
  apps.push(t)
  const { ctx } = t.app
  const info: IdPInfo = { issuer: idp.issuer, clientId: 'mm-client' }
  // What the MongoDB server would name (the probe is a connection attempt that stops at it).
  ;(ctx.oidc as unknown as { deps: { probe: () => Promise<IdPInfo> } }).deps.probe = async () => info
  const conn = ctx.connections.create(
    { name: 'oidc', favorite: false, readOnly: false, settings: oidcSettings },
    null,
  )
  const person = (username: string) => {
    const user = ctx.users.create({ username, passwordHash: 'x', role: 'editor' })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return { user, cookies: { mm_sid: sessionId }, headers: { ...H, 'x-csrf-token': session.csrfToken } }
  }
  return { t, ctx, conn, person, info }
}

interface Person {
  user: { id: string }
  cookies: Record<string, string>
  headers: Record<string, string>
}

async function signIn(t: TestApp, connId: string, p: Person) {
  const start = await t.app.inject({
    method: 'POST',
    url: `/api/connections/${connId}/oidc/start`,
    headers: p.headers,
    cookies: p.cookies,
    payload: { flow: 'code', returnTo: `/connections/${connId}` },
  })
  expect(start.statusCode).toBe(200)
  const binding = bindingOf(start)
  const back = idp.authorize(start.json().authorizeUrl as string)
  const done = await t.app.inject({
    method: 'GET',
    url: `/oidc/callback?state=${encodeURIComponent(back.state)}&code=${back.code}`,
    headers: { host: H.host },
    // A cross-site navigation from the identity provider: no session cookie (SameSite=Strict).
    cookies: { [binding.name]: binding.value },
  })
  return { start, binding, done }
}

/** The flow's own binding cookie (security review Minor 1: one per flow, named by it). */
const bindingOf = (start: { cookies: Array<{ name: string; value: string }> }) =>
  start.cookies.find((c) => /^mm_oidc_[A-Za-z0-9_-]{16}$/.test(c.name))!

describe('W7: OIDC sign-in over HTTP', () => {
  it('signs a person in with the authorization code flow and sends them back into the app', async () => {
    const { t, conn, person } = await teamApp()
    const ana = person('ana')
    const { start, binding, done } = await signIn(t, conn.id, ana)
    // The redirect goes back to this app's own callback; the binding cookie is scoped to it.
    expect(new URL(start.json().authorizeUrl as string).searchParams.get('redirect_uri')).toBe(
      'http://localhost:4321/oidc/callback',
    )
    expect(binding).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/oidc/', maxAge: 600 })
    // Security review I5: the person is shown where they sign in and where their token goes first.
    expect(start.json()).toMatchObject({ issuer: idp.issuer, tokenHosts: ['localhost'] })
    expect(done.statusCode).toBe(303)
    expect(done.headers.location).toBe(`/connections/${conn.id}?oidc=signed-in`)
    const status = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc`,
      headers: ana.headers,
      cookies: ana.cookies,
    })
    expect(status.json()).toMatchObject({ signIn: 'person', signedIn: true, issuer: idp.issuer })
  })

  // Abuse case: tokens are a person's own; another user of the same connection is not signed in.
  it('never shares one person’s sign-in with another', async () => {
    const { t, conn, person } = await teamApp()
    const ana = person('ana')
    const bob = person('bob')
    await signIn(t, conn.id, ana)
    const theirs = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc`,
      headers: bob.headers,
      cookies: bob.cookies,
    })
    expect(theirs.json()).toMatchObject({ signedIn: false })
  })

  it('never puts a token in an answer, the audit log or the redirect', async () => {
    const { t, ctx, conn, person } = await teamApp()
    const ana = person('ana')
    const { start, done } = await signIn(t, conn.id, ana)
    const status = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc`,
      headers: ana.headers,
      cookies: ana.cookies,
    })
    const audit = JSON.stringify(ctx.store.db.prepare('SELECT * FROM audit_log').all())
    for (const text of [start.body, done.headers.location, status.body, audit])
      expect(String(text)).not.toMatch(/[ar]t-\d+-[0-9a-f]{12}/)
    expect(audit).toContain('connections.oidc.callback')
  })

  // Abuse case (login CSRF): an attacker's flow finished in the victim's browser.
  it('refuses a callback without the binding cookie of the browser that started it', async () => {
    const { t, conn, person } = await teamApp()
    const eve = person('eve')
    const start = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: eve.headers,
      cookies: eve.cookies,
      payload: { flow: 'code' },
    })
    const back = idp.authorize(start.json().authorizeUrl as string)
    const res = await t.app.inject({
      method: 'GET',
      url: `/oidc/callback?state=${encodeURIComponent(back.state)}&code=${back.code}`,
      headers: { host: H.host },
    })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/?oidc_error=oidc_state')
    const status = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc`,
      headers: eve.headers,
      cookies: eve.cookies,
    })
    expect(status.json()).toMatchObject({ signedIn: false })
  })

  it('sends the browser back to a path of this app only', async () => {
    const { t, conn, person } = await teamApp()
    const ana = person('ana')
    for (const returnTo of [
      '//evil.example/x',
      'https://evil.example/',
      '/\\evil.example',
      'javascript:alert(1)',
    ]) {
      const start = await t.app.inject({
        method: 'POST',
        url: `/api/connections/${conn.id}/oidc/start`,
        headers: ana.headers,
        cookies: ana.cookies,
        payload: { flow: 'code', returnTo },
      })
      const binding = bindingOf(start)
      const back = idp.authorize(start.json().authorizeUrl as string)
      const done = await t.app.inject({
        method: 'GET',
        url: `/oidc/callback?state=${encodeURIComponent(back.state)}&code=${back.code}`,
        headers: { host: H.host },
        cookies: { [binding.name]: binding.value },
      })
      expect(done.headers.location, returnTo).toBe('/?oidc=signed-in')
    }
  })

  it('signs out (revoking at the identity provider), and administrators revoke everyone', async () => {
    const { t, ctx, conn, person } = await teamApp()
    const ana = person('ana')
    const bob = person('bob')
    await signIn(t, conn.id, ana)
    await signIn(t, conn.id, bob)
    const out = await t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${conn.id}/oidc`,
      headers: ana.headers,
      cookies: ana.cookies,
    })
    expect(out.statusCode).toBe(204)
    expect(ctx.oidc.status(conn.id, ana.user.id).signedIn).toBe(false)
    expect(ctx.oidc.status(conn.id, bob.user.id).signedIn).toBe(true)
    // An editor may not revoke others.
    const refused = await t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${conn.id}/oidc/sessions`,
      headers: ana.headers,
      cookies: ana.cookies,
    })
    expect(refused.statusCode).toBe(403)
    const admin = ctx.users.create({ username: 'root', passwordHash: 'x', role: 'admin' })
    const s = ctx.sessions.create(admin.id, {})
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc/sessions`,
      headers: H,
      cookies: { mm_sid: s.sessionId },
    })
    expect(list.json()).toEqual([expect.objectContaining({ username: 'bob', issuer: idp.issuer })])
    expect(list.body).not.toMatch(/[ar]t-\d+-[0-9a-f]{12}/)
    const all = await t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${conn.id}/oidc/sessions`,
      headers: { ...H, 'x-csrf-token': s.session.csrfToken },
      cookies: { mm_sid: s.sessionId },
    })
    expect(all.statusCode).toBe(204)
    expect(ctx.oidc.status(conn.id, bob.user.id).signedIn).toBe(false)
  })

  it('drops every sign-in when the connection’s settings change, and when a user is deleted', async () => {
    const { t, ctx, conn, person } = await teamApp()
    const ana = person('ana')
    await signIn(t, conn.id, ana)
    await ctx.oidc.forgetUser(ana.user.id)
    expect(ctx.oidc.status(conn.id, ana.user.id).signedIn).toBe(false)
    await signIn(t, conn.id, ana)
    const admin = ctx.users.create({ username: 'root', passwordHash: 'x', role: 'admin' })
    const s = ctx.sessions.create(admin.id, {})
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/connections/${conn.id}`,
      headers: { ...H, 'x-csrf-token': s.session.csrfToken },
      cookies: { mm_sid: s.sessionId },
      payload: { settings: { ...oidcSettings, hosts: [{ host: '127.0.0.1', port: 27018 }] } },
    })
    expect(patch.statusCode).toBe(200)
    expect(ctx.oidc.status(conn.id, ana.user.id).signedIn).toBe(false)
  })

  it('shows a code for the device flow, never the device code itself', async () => {
    const { t, conn, person } = await teamApp({ oidcDeviceFlow: true })
    const ana = person('ana')
    const start = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'device' },
    })
    expect(start.statusCode).toBe(200)
    expect(start.json()).toMatchObject({
      flow: 'device',
      device: { userCode: 'WDJB-MJHT', state: 'pending' },
    })
    expect(start.body).not.toMatch(/device_code|deviceCode/)
  })

  it('refuses sign-in on a connection that does not use OIDC', async () => {
    const { t, ctx, person } = await teamApp()
    const plain = ctx.connections.create(
      {
        name: 'p',
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'h' }] }),
      },
      null,
    )
    const ana = person('ana')
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${plain.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'code' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'not_oidc' })
  })
})

describe('W7 security review: sign-in over HTTP', () => {
  const adminOf = (ctx: TestApp['app']['ctx']) => {
    const admin = ctx.users.create({ username: 'root', passwordHash: 'x', role: 'admin' })
    const s = ctx.sessions.create(admin.id, {})
    return { cookies: { mm_sid: s.sessionId }, headers: { ...H, 'x-csrf-token': s.session.csrfToken } }
  }

  // Minor 1: two sign-ins waiting at once in one browser (two tabs, two connections) both finish.
  it('binds each sign-in to a cookie of its own, so several can wait at once', async () => {
    const { t, conn, person } = await teamApp()
    const ana = person('ana')
    const start = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/connections/${conn.id}/oidc/start`,
        headers: ana.headers,
        cookies: ana.cookies,
        payload: { flow: 'code' },
      })
    const [first, second] = [await start(), await start()]
    const [a, b] = [bindingOf(first), bindingOf(second)]
    expect(a.name).not.toBe(b.name)
    const back = idp.authorize(first.json().authorizeUrl as string)
    const done = await t.app.inject({
      method: 'GET',
      url: `/oidc/callback?state=${encodeURIComponent(back.state)}&code=${back.code}`,
      headers: { host: H.host },
      // The browser sends both; the first flow's own is the one that counts.
      cookies: { [a.name]: a.value, [b.name]: b.value },
    })
    expect(done.headers.location).toBe('/?oidc=signed-in')
    // The second flow's cookie does not finish the first one's (nor the reverse).
    const again = await start()
    const c = bindingOf(again)
    const back2 = idp.authorize(again.json().authorizeUrl as string)
    const wrong = await t.app.inject({
      method: 'GET',
      url: `/oidc/callback?state=${encodeURIComponent(back2.state)}&code=${back2.code}`,
      headers: { host: H.host },
      cookies: { [b.name]: c.value },
    })
    expect(wrong.headers.location).toBe('/?oidc_error=oidc_state')
  })

  // Minor 1: on https at the root, the cookie is a __Host- one (no Domain, Path=/, Secure).
  it('names the cookie __Host- on https at the root, __Secure- under a base path', () => {
    expect(bindingCookie({ secure: true, basePath: '/', flowId: 'abc' })).toEqual({
      name: '__Host-mm_oidc_abc',
      secure: true,
      path: '/',
    })
    expect(bindingCookie({ secure: true, basePath: '/mm/', flowId: 'abc' })).toEqual({
      name: '__Secure-mm_oidc_abc',
      secure: true,
      path: '/mm/oidc/',
    })
    expect(bindingCookie({ secure: false, basePath: '/', flowId: 'abc' })).toEqual({
      name: 'mm_oidc_abc',
      secure: false,
      path: '/oidc/',
    })
  })

  // I5, abuse case: a MongoDB server that names another identity provider than the administrator set.
  it('refuses an identity provider other than the one the connection expects', async () => {
    const { t, ctx, conn, person } = await teamApp()
    ctx.connections.update(conn.id, {
      settings: {
        ...oidcSettings,
        auth: { mechanism: 'MONGODB-OIDC', oidc: { expectedIssuer: 'https://login.corp.example' } },
      },
    })
    const ana = person('ana')
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'code' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'oidc_issuer_mismatch' })
    expect(res.cookies.some((c) => c.name.includes('mm_oidc'))).toBe(false)
  })

  // I6: who signed in at the identity provider shows in the sessions list and the audit log.
  it('says as whom each person signed in, to administrators and in the audit log', async () => {
    const { t, ctx, conn, person } = await teamApp()
    await signIn(t, conn.id, person('ana'))
    const admin = adminOf(ctx)
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/connections/${conn.id}/oidc/sessions`,
      headers: H,
      cookies: admin.cookies,
    })
    expect(list.json()).toEqual([
      expect.objectContaining({ username: 'ana', signedInAs: 'ana@corp.example', subject: 'ana' }),
    ])
    const audit = ctx.store.db
      .prepare("SELECT details FROM audit_log WHERE action = 'connections.oidc.callback'")
      .all() as Array<{ details: string }>
    expect(audit.map((a) => a.details).join()).toContain('ana@corp.example')
  })

  // I6, abuse case: someone hands another person their device code; whoever approves it signs in.
  it('keeps sign-in with a code off in team mode unless the server allows it', async () => {
    const { t, conn, person } = await teamApp()
    const ana = person('ana')
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'device' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'oidc_device_off' })
    const caps = await t.app.inject({
      method: 'GET',
      url: '/api/connections/capabilities',
      headers: ana.headers,
      cookies: ana.cookies,
    })
    expect(caps.json().oidc).toMatchObject({ deviceFlow: false })
  })

  it('records who a device sign-in signed in, once it completes', async () => {
    const { t, ctx, conn, person } = await teamApp({ oidcDeviceFlow: true })
    const ana = person('ana')
    await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'device' },
    })
    idp.approveDevice('WDJB-MJHT')
    const status = async () =>
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/connections/${conn.id}/oidc`,
          headers: ana.headers,
          cookies: ana.cookies,
        })
      ).json()
    // The broker polls no faster than the provider asks: its next poll is made due here.
    const flows = (ctx.oidc as unknown as { deviceFlows: Map<string, { nextPollAt: number }> }).deviceFlows
    for (const f of flows.values()) f.nextPollAt = 0
    const s = await status()
    expect(s.signedIn).toBe(true)
    expect(s).not.toHaveProperty('completed')
    await status()
    const audit = ctx.store.db
      .prepare("SELECT details FROM audit_log WHERE action = 'connections.oidc.signIn'")
      .all() as Array<{ details: string }>
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toContain('ana@corp.example')
  })

  // Minor 5, abuse case: in team mode the code goes back to this server only, whatever a connection says.
  it('sends the browser back to this server’s own callback in team mode', async () => {
    const { t, ctx, conn, person } = await teamApp()
    ctx.connections.update(conn.id, {
      settings: {
        ...oidcSettings,
        auth: { mechanism: 'MONGODB-OIDC', oidc: { redirectUri: 'https://collector.evil.example/cb' } },
      },
    })
    const ana = person('ana')
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/connections/${conn.id}/oidc/start`,
      headers: ana.headers,
      cookies: ana.cookies,
      payload: { flow: 'code' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().details).toMatchObject({ reason: 'oidc_redirect_foreign' })
  })

  // Minor 7, abuse case: a sign-in's probe dials the MongoDB server as a connection test does; it
  // takes the person's one test slot, so starting sign-ins cannot dial without end.
  it('probes the MongoDB server within the person’s own connection-test slot', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const conn = ctx.connections.create(
      { name: 'o', favorite: false, readOnly: false, settings: oidcSettings },
      null,
    )
    const user = ctx.users.create({ username: 'ana', passwordHash: 'x', role: 'editor' })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const held = ctx.connectionTests.acquire(user.id)!
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/connections/${conn.id}/oidc/start`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload: { flow: 'code' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().details).toMatchObject({ reason: 'oidc_busy' })
    } finally {
      held()
    }
  })

  // Re-review item 5: a user's sign-ins are revoked at the provider once their deletion committed —
  // never from inside it (a deletion rolled back would leave them signed out at the provider).
  it('revokes a deleted user’s sign-ins after the deletion commits', async () => {
    const { t, ctx, conn, person } = await teamApp()
    const ana = person('ana')
    await signIn(t, conn.id, ana)
    const refresh = (
      ctx.oidc as unknown as { deps: { tokens: { get(c: string, u: string): { refreshToken?: string } } } }
    ).deps.tokens.get(conn.id, ana.user.id)!.refreshToken!
    const during: boolean[] = []
    const forget = ctx.oidc.forgetUser.bind(ctx.oidc)
    ctx.oidc.forgetUser = (user: string) => {
      during.push(ctx.store.db.isTransaction)
      return forget(user)
    }
    const admin = adminOf(ctx)
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${ana.user.id}`,
      headers: admin.headers,
      cookies: admin.cookies,
    })
    expect(del.statusCode).toBe(204)
    expect(during).toEqual([false])
    expect(idp.revoked).toContain(refresh)
  })

  // Minor 3: deleting a connection revokes its sign-ins at the identity provider.
  it('revokes the sign-ins of a deleted connection at the identity provider', async () => {
    const { t, ctx, conn, person } = await teamApp()
    const ana = person('ana')
    await signIn(t, conn.id, ana)
    const refresh = (
      ctx.oidc as unknown as { deps: { tokens: { get(c: string, u: string): { refreshToken?: string } } } }
    ).deps.tokens.get(conn.id, ana.user.id)!.refreshToken!
    const admin = adminOf(ctx)
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/connections/${conn.id}`,
      headers: admin.headers,
      cookies: admin.cookies,
    })
    expect(del.statusCode).toBe(204)
    expect(idp.revoked).toContain(refresh)
  })
})
