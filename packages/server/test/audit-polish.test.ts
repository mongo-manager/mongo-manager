import { afterEach, describe, expect, it } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { hashPassword } from '../src/auth/passwords'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const DAY = 86_400_000

async function local() {
  const t = await makeApp()
  apps.push(t)
  const headers = { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }
  const call = (method: 'GET' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url: `/api/${url}`, headers, ...(payload ? { payload } : {}) })
  const add = (over: Partial<Parameters<typeof t.app.ctx.audit.append>[0]> = {}) =>
    t.app.ctx.audit.append({
      userId: null,
      username: 'owner',
      ip: '127.0.0.1',
      action: 'x.test' as AuditAction,
      outcome: 'success',
      details: {},
      ...over,
    })
  return { t, call, add }
}

async function team() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({
      username: `u-${role}-${Math.random().toString(36).slice(2, 8)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'PUT', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  return { t, as }
}

describe('audit export (phase 4c §1)', () => {
  it('exports every matching entry, oldest first, as CSV or NDJSON', async () => {
    const { t, call, add } = await local()
    t.clock.now = Date.UTC(2026, 0, 1)
    add({ action: 'documents.update', connectionId: 'c1', namespace: 'shop.orders', details: { n: 1 } })
    t.clock.now = Date.UTC(2026, 0, 2)
    add({ action: 'documents.delete', connectionId: 'c2' })
    t.clock.now = Date.UTC(2026, 0, 3)
    add({ action: 'documents.update', connectionId: 'c1' })
    const nd = await call('GET', 'audit/export?format=ndjson&connectionId=c1')
    expect(nd.statusCode).toBe(200)
    expect(nd.headers['content-type']).toContain('application/x-ndjson')
    expect(nd.headers['content-disposition']).toMatch(/^attachment; filename="audit-\d{8}-\d{6}\.ndjson"$/)
    const lines = nd.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => [l.action, l.namespace])).toEqual([
      ['documents.update', 'shop.orders'],
      ['documents.update', null],
    ])
    expect(lines[0].details).toEqual({ n: 1 })
    const csv = await call('GET', 'audit/export?format=csv')
    expect(csv.headers['content-type']).toContain('text/csv')
    const rows = csv.payload.trim().split('\r\n')
    expect(rows[0]).toBe(
      '"id","at","username","userId","ip","action","outcome","connectionId","namespace","details"',
    )
    expect(rows[1]).toContain('2026-01-01T00:00:00.000Z')
    expect(rows[1]).toContain('"{""n"":1}"')
    // The export itself is audited.
    expect(t.app.ctx.audit.list({ action: 'audit.export' })[0]).toMatchObject({
      outcome: 'success',
      details: { format: 'csv' },
    })
  })

  it('never lets a cell run as a spreadsheet formula', async () => {
    const { call, add } = await local()
    for (const evil of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])
      add({ action: 'x.test' as AuditAction, namespace: evil })
    const csv = (await call('GET', 'audit/export?format=csv')).payload
    for (const evil of ['=HYPERLINK', '+1+1', '-2+3', '@SUM']) {
      // Every character a regular expression reads as syntax escaped, the backslash first among them.
      const literal = evil.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
      expect(csv).not.toMatch(new RegExp(`(^|,)"?${literal}`, 'm'))
      expect(csv).toContain(`'${evil}`)
    }
  })

  it('keeps a semicolon-separated spreadsheet (Turkish Excel) from splitting a cell into a formula (4c review I2)', async () => {
    const { call, add } = await local()
    // A name anyone can type at the sign-in page, without an account.
    add({ action: 'auth.login', outcome: 'denied', username: "x;=cmd|' /C calc'!A0" })
    add({ action: 'x.test' as AuditAction, namespace: '  =1+1' })
    add({ action: 'x.test' as AuditAction, namespace: 'a\n=1+1' })
    const csv = (await call('GET', 'audit/export?format=csv')).payload
    const rows = csv.trim().split('\r\n')
    // Every cell is quoted: a separator inside one never splits it.
    for (const row of rows.slice(1)) expect(row.startsWith('"')).toBe(true)
    expect(csv).toContain(`"x;=cmd|' /C calc'!A0"`)
    expect(csv).toContain(`"'  =1+1"`)
    expect(csv).toContain('"a\n=1+1"')
  })

  it('refuses a bad format or range, and anyone without audit:read', async () => {
    const { call } = await local()
    expect((await call('GET', 'audit/export?format=xlsx')).statusCode).toBe(400)
    expect((await call('GET', 'audit/export?format=csv&from=yesterday')).statusCode).toBe(400)
    const { as } = await team()
    expect((await as('editor')('GET', 'audit/export?format=csv')).statusCode).toBe(403)
    expect((await as('admin')('GET', 'audit/export?format=csv')).statusCode).toBe(200)
  })
})

describe('audit retention (phase 4c §2)', () => {
  it('keeps everything by default; fewer days start a day later, then go hourly (4c review I4)', async () => {
    const { t, call, add } = await local()
    expect((await call('GET', 'audit/settings')).json()).toEqual({ days: null, effectiveAt: null })
    t.clock.now = Date.UTC(2026, 0, 1)
    add({ action: 'old.one' as AuditAction })
    t.clock.now = Date.UTC(2026, 2, 1)
    add({ action: 'recent.one' as AuditAction })
    // Nothing goes while kept for ever.
    expect(await t.app.ctx.audit.sweep()).toBe(0)
    // How many fewer days would take, asked before.
    expect((await call('GET', 'audit/settings?preview=30')).json()).toMatchObject({ wouldRemove: 1 })
    const set = (await call('PUT', 'audit/settings', { days: 30 })).json()
    expect(set).toEqual({ days: 30, effectiveAt: Date.UTC(2026, 2, 2) })
    const left = () => t.app.ctx.audit.list({ limit: 500 }).map((e) => e.action)
    // A day to take it back, or to export first: nothing goes yet.
    expect(await t.app.ctx.audit.sweep()).toBe(0)
    expect(left()).toContain('old.one')
    t.clock.now = Date.UTC(2026, 2, 2, 1)
    expect(await t.app.ctx.audit.sweep()).toBe(1)
    expect(left()).not.toContain('old.one')
    expect(left()).toContain('recent.one')
    // The purge itself is kept, saying how many and before when.
    expect(t.app.ctx.audit.list({ action: 'audit.retention' })[0]).toMatchObject({
      details: { removed: 1, days: 30 },
    })
    // More days (or for ever) take effect at once, with no wait.
    expect((await call('PUT', 'audit/settings', { days: 90 })).json()).toEqual({
      days: 90,
      effectiveAt: Date.UTC(2026, 2, 2, 1),
    })
  })

  it('removes a large log in batches', async () => {
    const { t, call, add } = await local()
    t.clock.now = Date.UTC(2026, 0, 1)
    // In one transaction: twelve thousand commits wait on the disk far longer than the test may.
    const db = (t.app.ctx.audit as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.exec('BEGIN')
    for (let i = 0; i < 12_050; i++) add({ action: 'bulk' as AuditAction })
    db.exec('COMMIT')
    t.clock.now = Date.UTC(2026, 5, 1)
    await call('PUT', 'audit/settings', { days: 30 })
    t.clock.now = Date.UTC(2026, 5, 3)
    // The settings change itself is newer than the cut-off: it stays.
    expect(await t.app.ctx.audit.sweep()).toBe(12_050)
    expect(t.app.ctx.audit.list({ action: 'bulk' })).toEqual([])
  })

  it('asks the password of who shortens the log, in team mode (4c review I4)', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const admin = ctx.users.create({
      username: 'boss',
      passwordHash: await hashPassword('the right password'),
      role: 'admin',
    })
    let signedIn = ctx.sessions.create(admin.id, {})
    const put = (payload: object) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/audit/settings',
        headers: { ...H, 'x-csrf-token': signedIn.session.csrfToken },
        cookies: { mm_sid: signedIn.sessionId },
        payload,
      })
    for (const body of [{ days: 30 }, { days: 30, password: 'wrong one' }]) {
      const res = await put(body)
      expect([res.statusCode, res.json().details?.reason]).toEqual([400, 'wrong_password'])
    }
    expect((await put({ days: 30, password: 'the right password' })).statusCode).toBe(200)
    // Once in force, more days need none; for ever never does.
    t.clock.now += 2 * DAY
    // (Signed in again: a session idle two days has expired.)
    signedIn = ctx.sessions.create(admin.id, {})
    expect((await put({ days: 365 })).statusCode).toBe(200)
    expect((await put({ days: null })).statusCode).toBe(200)
    // Fewer than those in force while a change waits still ask (no way round the wait).
    expect((await put({ days: 3000 })).statusCode).toBe(400)
  })

  it('refuses fewer than 30 days, and a change by anyone but an administrator', async () => {
    const { call } = await local()
    for (const days of [0, 29, 3651, 1.5, '30'])
      expect((await call('PUT', 'audit/settings', { days })).statusCode).toBe(400)
    const { as } = await team()
    expect((await as('editor')('PUT', 'audit/settings', { days: 90 })).statusCode).toBe(403)
    // An administrator gets as far as the password.
    const admin = await as('admin')('PUT', 'audit/settings', { days: 90 })
    expect([admin.statusCode, admin.json().details?.reason]).toEqual([400, 'wrong_password'])
  })

  it('stays append-only outside the purge: no update, no delete, not even of old entries', async () => {
    const { t, add } = await local()
    add()
    const db = (t.app.ctx.audit as unknown as { db: import('node:sqlite').DatabaseSync }).db
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/)
    expect(() => db.exec("UPDATE audit_log SET action = 'y'")).toThrow(/append-only/)
    // A gate left open (a crash mid-purge) never covers anything newer than its cut-off.
    db.prepare('INSERT INTO audit_purge (before) VALUES (?)').run(0)
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/)
  })
})

// Found by the e2e of the 4c export: an entry written by a background job (an import, a backup)
// had the user's id but no name, so an export did not say who it was.
describe('who an entry is about', () => {
  it('names the user of an entry written with an id alone', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const user = ctx.users.create({ username: 'ada', passwordHash: 'x', role: 'editor' })
    ctx.audit.append({ userId: user.id, username: null, action: 'transfer.import', outcome: 'success' })
    ctx.audit.append({
      userId: null,
      username: null,
      action: 'system.thing' as AuditAction,
      outcome: 'success',
    })
    ctx.audit.append({
      userId: 'gone-user',
      username: null,
      action: 'x.gone' as AuditAction,
      outcome: 'success',
    })
    const byAction = (a: string) => ctx.audit.list({ action: a, limit: 1 })[0]!
    expect(byAction('transfer.import').username).toBe('ada')
    expect(byAction('system.thing').username).toBeNull()
    expect(byAction('x.gone').username).toBeNull()
  })
})
