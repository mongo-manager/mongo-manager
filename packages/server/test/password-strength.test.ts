import { afterEach, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { H, makeApp, type TestApp } from './helpers'
import { hashPassword } from '../src/auth/passwords'

/** Password strength (2026-10-28): every way an account's password is set refuses a guessable one. */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const PASSWORD = 'tarçın-kavanoz-42-mavi'
const GUESSABLE = 'Password1234!'
const sid = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'mm_sid')?.value

async function admin() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: H,
    payload: { token: t.app.ctx.setup.ensureToken(), username: 'admin', password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  const csrf = res.json().csrfToken as string
  const cookies = { mm_sid: sid(res)! }
  const post = (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: { ...H, 'x-csrf-token': csrf }, cookies, payload })
  return { t, post }
}

const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().details]
const PREDICTABLE = { reason: 'weak_password', problems: ['too_predictable'] }

describe('a guessable account password', () => {
  it('is refused when changing one’s own, with what counts as guessable', async () => {
    const { post } = await admin()
    const res = await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: GUESSABLE })
    expect(refusal(res)).toEqual([400, PREDICTABLE])
    expect(res.json().message).toContain(
      'is too easy to guess (a sequence, a keyboard row, a repeat or a common word)',
    )
  })

  it('is refused when adding a user, and when resetting one’s password', async () => {
    const { t, post } = await admin()
    const added = await post('/api/users', {
      username: 'bob',
      password: GUESSABLE,
      role: 'viewer',
      currentPassword: PASSWORD,
    })
    expect(refusal(added)).toEqual([400, PREDICTABLE])
    expect(t.app.ctx.users.findByUsername('bob')).toBeUndefined()
    const bob = t.app.ctx.users.create({
      username: 'bob',
      passwordHash: await hashPassword(PASSWORD),
      role: 'viewer',
    })
    const reset = await post(`/api/users/${bob.id}/password`, {
      password: GUESSABLE,
      currentPassword: PASSWORD,
    })
    expect(refusal(reset)).toEqual([400, PREDICTABLE])
  })

  it('set before the rule still signs in: only a new password is checked', async () => {
    const { t } = await admin()
    t.app.ctx.users.create({ username: 'old', passwordHash: await hashPassword(GUESSABLE), role: 'viewer' })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { username: 'old', password: GUESSABLE },
    })
    expect(res.statusCode).toBe(200)
  })
})
