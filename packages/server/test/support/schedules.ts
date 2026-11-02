import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import type { BackupKeyCreated, Role } from '@mongo-manager/shared'
import type { PartialConfig } from '../../src/config'
import { parseKit } from '../../src/backup/keys/kit'
import { H, makeApp } from '../helpers'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Reply = LightMyRequestResponse
export interface Caller {
  id: string
  username: string
  call(method: Method, url: string, payload?: unknown): Promise<Reply>
  get(url: string): Promise<Reply>
  raw(method: Method, url: string, body: Buffer): Promise<Reply>
}

/** Phase 3d-3c: team mode without MongoDB, for the key and schedule routes that read no data. */
export async function teamApp(overrides: PartialConfig = {}, extra: Parameters<typeof makeApp>[1] = {}) {
  const t = await makeApp({ auth: true, ...overrides }, extra)
  const { ctx } = t.app
  const user = (role: Role = 'editor'): Caller => {
    const u = ctx.users.create({ username: `u-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role })
    const s = ctx.sessions.create(u.id, {})
    const headers = { ...H, 'x-csrf-token': s.session.csrfToken }
    const cookies = { mm_sid: s.sessionId }
    const call = (method: Method, url: string, payload?: unknown) =>
      t.app.inject({
        method,
        url,
        headers,
        cookies,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    const raw = (method: Method, url: string, body: Buffer) =>
      t.app.inject({
        method,
        url,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        cookies,
        payload: body,
      })
    return { id: u.id, username: u.username, call, get: (url: string) => call('GET', url), raw }
  }
  return { t, ctx, user }
}

/** A created and confirmed key: its id, its kit (as shown once), its fingerprint and the raw key. */
export async function confirmedKey(u: Pick<Caller, 'call'>, name?: string) {
  const res = await u.call('POST', '/api/backup-keys', name ? { name } : {})
  if (res.statusCode !== 201) throw new Error(res.body)
  const created = res.json() as BackupKeyCreated
  const check = created.kit.match(/MMKEY1-\S+/)![0].slice(-4)
  const ok = await u.call('POST', `/api/backup-keys/${created.key.id}/confirm`, { check })
  if (ok.statusCode !== 200) throw new Error(ok.body)
  return {
    id: created.key.id,
    kit: created.kit,
    fingerprint: created.key.fingerprint,
    key: parseKit(created.kit),
  }
}
