import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EgressError, createEgress } from '../src/net/egress'
import { adapterFor, layoutPrefix, registryDeps, testDestination } from '../src/backup/destinations/registry'
import type { RegistryDeps } from '../src/backup/destinations/registry'
import type { DestinationRecord } from '../src/backup/destinations/repo'
import { DestinationError, type DestinationAdapter } from '../src/backup/destinations/types'
import type { GoogleTokens } from '../src/backup/destinations/google-auth'
import { backupLimits } from '../src/backup/limits'
import { resolveConfig } from '../src/config'
import { makeApp } from './helpers'
import { installDrive, startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { startFakeWebdav } from './support/fake-webdav'

let g: FakeGoogle
let dav: Awaited<ReturnType<typeof startFakeWebdav>>
let base: string
beforeAll(async () => {
  ;[g, dav] = await Promise.all([
    startFakeGoogle(),
    startFakeWebdav({ user: 'dav-user', password: 'dav-pass-1' }),
  ])
  installDrive(g)
  base = mkdtempSync(join(tmpdir(), 'mm-reg-more-'))
  mkdirSync(join(base, 'root'))
})
afterAll(async () => {
  await Promise.all([g?.close(), dav?.close()])
  if (base) rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  g.files.clear()
  g.revoked.clear()
})

const ID = '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'
const record = (
  type: DestinationRecord['type'],
  config: Record<string, unknown>,
  over: Partial<DestinationRecord> = {},
): DestinationRecord => ({
  id: ID,
  name: 'x',
  type,
  config,
  policy: { encryptedOnly: true },
  status: { state: 'unknown', checkedAt: null },
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  secretFields: [],
  ...over,
})
function deps(networks: string[] = ['127.0.0.1/32']) {
  const config = resolveConfig({
    cli: { dataDir: join(base, 'data') },
    env: { MM_BACKUP_FOLDER_ROOTS: join(base, 'root') },
  })
  const saved: Array<{ id: string; patch: Record<string, unknown> }> = []
  const d: RegistryDeps = {
    egress: createEgress({ networks }),
    googleHosts: g.hosts,
    limits: backupLimits(config),
    dataDir: join(base, 'data'),
    now: () => Date.now(),
    tokens: new Map<string, GoogleTokens>(),
    saveStatus: (id, patch) => saved.push({ id, patch }),
  }
  return { d, saved }
}
const signal = new AbortController().signal
const saKey = () => JSON.stringify({ type: 'service_account', ...g.serviceKey })
const oauthConfig = { auth: 'oauth', clientId: 'client-id-0001.apps.googleusercontent.com' }
const saConfig = { auth: 'serviceAccount', sharedDriveId: 'shared-drive-0001' }
const oauthSecrets = { clientSecret: 'client-secret-1', refreshToken: '1//refresh-1' }
const tokenCalls = () => g.requests.filter((r) => r === 'POST /token').length

/** A scripted adapter: each operation answers what the test says, and records that it ran. */
function stub(over: Partial<DestinationAdapter> = {}, endpoint: URL | null = new URL('https://127.0.0.1:1')) {
  const calls: string[] = []
  const stored = new Map<string, Buffer>()
  const adapter: DestinationAdapter = {
    readBack: false,
    endpoint: () => endpoint,
    caPem: () => undefined,
    async authCheck() {
      calls.push('auth')
      return {}
    },
    async put() {
      throw new Error('not used')
    },
    async putSmall(key, body) {
      calls.push(`put ${key}`)
      stored.set(key, body)
    },
    async stat() {
      return null
    },
    async get() {
      throw new Error('not used')
    },
    async getSmall(key) {
      calls.push(`get ${key}`)
      return stored.get(key) ?? null
    },
    async list() {
      return { items: [], cursor: null }
    },
    async remove(key) {
      calls.push(`remove ${key}`)
      stored.delete(key)
    },
    async abandon() {
      return undefined
    },
    ...over,
  }
  return { adapter, calls, stored }
}
const probing = (probe: () => Promise<{ resolveMs: number; connectMs: number }>) =>
  ({ egress: { probe } as never, now: () => 1000 }) as Pick<RegistryDeps, 'egress' | 'now'>
const ok = probing(async () => ({ resolveMs: 3, connectMs: 4 }))
const summary = (steps: Array<{ step: string; ok: boolean; reason?: string }>) =>
  steps.map((s) => `${s.step}:${s.ok ? 'ok' : (s.reason ?? 'fail')}`)

describe('layoutPrefix', () => {
  it('is the S3 prefix, and empty for every other type even when its config carries one', () => {
    expect(layoutPrefix(record('s3', { prefix: 'team/a' }))).toBe('team/a')
    expect(layoutPrefix(record('s3', {}))).toBe('')
    expect(layoutPrefix(record('webdav', { prefix: 'smuggled' }))).toBe('')
    expect(layoutPrefix(record('folder', { prefix: 'smuggled' }))).toBe('')
    expect(layoutPrefix(record('gdrive', { prefix: 'smuggled' }))).toBe('')
  })
})

describe('adapterFor (phase 3d-3b spec §2)', () => {
  it('refuses WebDAV without its password, and reaches the configured server with one', async () => {
    const { d } = deps()
    const config = {
      preset: 'generic',
      url: dav.url.replace(/\/$/, ''),
      username: 'dav-user',
      caPem: dav.caPem,
    }
    expect(() => adapterFor(record('webdav', config), {}, d)).toThrow(
      expect.objectContaining({ reason: 'secrets_missing' }),
    )
    expect(() => adapterFor(record('webdav', config), { password: '' }, d)).toThrow(DestinationError)
    const a = adapterFor(record('webdav', config), { password: 'dav-pass-1' }, d)
    expect(a.endpoint()?.origin).toBe(new URL(dav.url).origin)
    const out = await testDestination(a, '', d, signal)
    expect(summary(out.steps)).toEqual([
      'resolve:ok',
      'connect:ok',
      'auth:ok',
      'write:ok',
      'read:ok',
      'delete:ok',
    ])
    const wrong = await testDestination(
      adapterFor(record('webdav', config), { password: 'not-the-password' }, d),
      '',
      d,
      signal,
    )
    expect(wrong.steps.find((s) => s.step === 'auth')).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('refuses S3 with only half of its key pair', () => {
    const { d } = deps()
    const config = {
      preset: 'minio',
      endpoint: 'https://127.0.0.1:9',
      region: 'us-east-1',
      bucket: 'mm-test',
    }
    const halves: Array<Record<string, string>> = [
      { accessKeyId: 'AKIA0001' },
      { secretAccessKey: 'secret-secret' },
    ]
    for (const secrets of halves)
      expect(() => adapterFor(record('s3', config), secrets, d)).toThrow(
        expect.objectContaining({ reason: 'secrets_missing' }),
      )
  })

  it('refuses Drive without the secrets its sign-in needs', () => {
    const { d } = deps()
    expect(() => adapterFor(record('gdrive', saConfig), {}, d)).toThrow(
      expect.objectContaining({ reason: 'secrets_missing' }),
    )
    // An OAuth destination needs the refresh token as well: the client secret alone signs nobody in.
    expect(() => adapterFor(record('gdrive', oauthConfig), { clientSecret: 'client-secret-1' }, d)).toThrow(
      expect.objectContaining({ reason: 'secrets_missing' }),
    )
    // A service-account key is not enough for an OAuth destination (and the reverse).
    expect(() => adapterFor(record('gdrive', oauthConfig), { serviceAccountKey: saKey() }, d)).toThrow(
      expect.objectContaining({ reason: 'secrets_missing' }),
    )
    expect(() => adapterFor(record('gdrive', saConfig), oauthSecrets, d)).toThrow(
      expect.objectContaining({ reason: 'secrets_missing' }),
    )
    expect(d.tokens.size).toBe(0)
  })

  it('refuses a stored service-account key that is not one', () => {
    const { d } = deps()
    for (const key of ['{not json', JSON.stringify({ type: 'authorized_user', client_email: 'a@b.c' })])
      // Short names review 7 (M-1): a credential not valid, not Google's refusal (it is never asked).
      expect(() => adapterFor(record('gdrive', saConfig), { serviceAccountKey: key }, d)).toThrow(
        expect.objectContaining({ reason: 'secrets_invalid' }),
      )
    expect(d.tokens.size).toBe(0)
  })

  it('signs a service account in, names it as the account, and remembers the Drive folder', async () => {
    const { d, saved } = deps()
    const a = adapterFor(record('gdrive', saConfig), { serviceAccountKey: saKey() }, d)
    const out = await testDestination(a, '', d, signal)
    expect(summary(out.steps)).toEqual([
      'resolve:ok',
      'connect:ok',
      'auth:ok',
      'write:ok',
      'read:ok',
      'delete:ok',
    ])
    expect(out.account).toBe(g.serviceKey.client_email)
    // The folder Drive created is saved on the destination's status, not in its config.
    expect(saved).toEqual([{ id: ID, patch: { folderId: expect.stringMatching(/^f-/) } }])
    expect([...g.files.values()].some((f) => f.id === saved[0]!.patch.folderId)).toBe(true)
  })

  it('names the OAuth account from the status, or asks Drive when the status has none', async () => {
    const { d } = deps()
    const known = adapterFor(
      record('gdrive', oauthConfig, { status: { state: 'ok', checkedAt: 1, account: 'known@example.com' } }),
      oauthSecrets,
      d,
    )
    expect((await testDestination(known, '', d, signal)).account).toBe('known@example.com')
    const { d: d2 } = deps()
    const asked = adapterFor(record('gdrive', oauthConfig), oauthSecrets, d2)
    expect((await testDestination(asked, '', d2, signal)).account).toBe('ops@example.com')
  })

  it('reuses a known Drive folder instead of creating another', async () => {
    const { d, saved } = deps()
    const first = adapterFor(record('gdrive', oauthConfig), oauthSecrets, d)
    await first.authCheck(signal)
    const folderId = saved[0]!.patch.folderId as string
    const folders = () => [...g.files.values()].filter((f) => f.mimeType.endsWith('folder')).length
    const before = folders()
    const again = adapterFor(
      record('gdrive', oauthConfig, { status: { state: 'ok', checkedAt: 1, folderId } }),
      oauthSecrets,
      d,
    )
    await again.authCheck(signal)
    expect(folders()).toBe(before)
    expect(saved).toHaveLength(1)
  })

  it('keeps one access-token cache per destination version: reused while unchanged, replaced by an edit', async () => {
    const { d } = deps()
    const v1 = record('gdrive', oauthConfig, { updatedAt: 1 })
    await adapterFor(v1, oauthSecrets, d).authCheck(signal)
    const cached = d.tokens.get(`${ID}|1`)
    expect(cached).toBeDefined()
    const calls = tokenCalls()
    // The same version asks Google for no new access token.
    await adapterFor(v1, oauthSecrets, d).authCheck(signal)
    expect(tokenCalls()).toBe(calls)
    expect(d.tokens.get(`${ID}|1`)).toBe(cached)
    // Another destination's cache is not touched by this one's edit.
    const otherKey = '11111111-1111-4111-8111-111111111111|1'
    d.tokens.set(otherKey, cached!)
    const later = record('gdrive', oauthConfig, { updatedAt: 2 })
    await adapterFor(later, oauthSecrets, d).authCheck(signal)
    expect([...d.tokens.keys()].sort()).toEqual([`${ID}|2`, otherKey].sort())
    expect(d.tokens.get(`${ID}|2`)).not.toBe(cached)
    expect(tokenCalls()).toBe(calls + 1)
  })

  it('asks for a new connection when Google revoked the refresh token', async () => {
    const { d } = deps()
    g.revoked.add('1//refresh-1')
    const out = await testDestination(
      adapterFor(record('gdrive', oauthConfig), oauthSecrets, d),
      '',
      d,
      signal,
    )
    expect(out.steps.find((s) => s.step === 'auth')).toMatchObject({ ok: false, reason: 'reconnect' })
    expect(out.account).toBeUndefined()
  })
})

describe('testDestination (plan ruling 11)', () => {
  it('counts an unexpected connect failure as a connect step, never as a resolved address failure', async () => {
    const s = stub()
    const out = await testDestination(
      s.adapter,
      '',
      probing(async () => {
        throw new Error('socket hang up')
      }),
      signal,
    )
    expect(summary(out.steps)).toEqual([
      'resolve:ok',
      'connect:provider',
      'auth:skipped',
      'write:skipped',
      'read:skipped',
      'delete:skipped',
    ])
    expect(s.calls).toEqual([])
  })

  it('reports a TLS failure on connect with the provider code scrubbed of its query', async () => {
    const out = await testDestination(
      stub().adapter,
      '',
      probing(async () => {
        throw new EgressError(
          'tls',
          'bad certificate',
          'CERT_UNTRUSTED https://host/x?X-Amz-Signature=abcdef',
        )
      }),
      signal,
    )
    const connect = out.steps.find((s) => s.step === 'connect')!
    expect(connect).toMatchObject({ ok: false, reason: 'tls', ms: null })
    expect(connect.detail).toContain('CERT_UNTRUSTED')
    expect(connect.detail).not.toContain('Signature')
  })

  it('stops at the resolve step for a name that does not resolve', async () => {
    const out = await testDestination(
      stub().adapter,
      '',
      probing(async () => {
        throw new EgressError('dns', 'no such host')
      }),
      signal,
    )
    expect(summary(out.steps)).toEqual([
      'resolve:dns',
      'connect:skipped',
      'auth:skipped',
      'write:skipped',
      'read:skipped',
      'delete:skipped',
    ])
  })

  it('reports measured times and the account when every step passes', async () => {
    const s = stub({
      async authCheck() {
        return { account: 'me@example.com' }
      },
    })
    const out = await testDestination(s.adapter, 'team', ok, signal)
    expect(out.account).toBe('me@example.com')
    expect(out.steps.slice(0, 2)).toEqual([
      { step: 'resolve', ok: true, ms: 3 },
      { step: 'connect', ok: true, ms: 4 },
    ])
    // The probe goes under the destination's own layout root, and is removed again.
    const put = s.calls.find((c) => c.startsWith('put '))!
    expect(put).toMatch(/^put team\/mongo-manager\/\.probe-[0-9a-f]{16}$/)
    expect(s.calls).toContain(put.replace('put ', 'remove '))
    expect(s.stored.size).toBe(0)
  })

  it('never reports a negative time when the clock steps back', async () => {
    let t = 10_000
    const out = await testDestination(
      stub().adapter,
      '',
      { egress: { probe: async () => ({ resolveMs: 0, connectMs: 0 }) } as never, now: () => (t -= 500) },
      signal,
    )
    expect(out.steps.every((s) => s.ms === null || s.ms >= 0)).toBe(true)
  })

  it('skips read and delete when the write fails, and leaves nothing to remove', async () => {
    const s = stub({
      async putSmall() {
        throw new DestinationError('forbidden', 'read-only', { code: 'AccessDenied' })
      },
    })
    const out = await testDestination(s.adapter, '', ok, signal)
    expect(out.steps.find((x) => x.step === 'write')).toMatchObject({
      ok: false,
      reason: 'forbidden',
      detail: 'AccessDenied',
    })
    expect(summary(out.steps).slice(4)).toEqual(['read:skipped', 'delete:skipped'])
    expect(s.calls.some((c) => c.startsWith('remove'))).toBe(false)
  })

  it('fails the read step when the probe comes back different, and still removes it', async () => {
    const s = stub()
    s.adapter.getSmall = async (key) => {
      s.calls.push(`get ${key}`)
      return Buffer.from('something else')
    }
    const out = await testDestination(s.adapter, '', ok, signal)
    expect(summary(out.steps).slice(2)).toEqual(['auth:ok', 'write:ok', 'read:verify', 'delete:ok'])
    expect(s.calls.filter((c) => c.startsWith('remove'))).toHaveLength(1)
    expect(s.stored.size).toBe(0)
  })

  it('fails the read step when the probe is gone', async () => {
    const s = stub({ getSmall: async () => null })
    const out = await testDestination(s.adapter, '', ok, signal)
    expect(out.steps.find((x) => x.step === 'read')).toMatchObject({ ok: false, reason: 'verify' })
  })

  it('reports a delete the destination refused', async () => {
    const s = stub({
      async remove() {
        throw new EgressError('timeout', 'too slow')
      },
    })
    const out = await testDestination(s.adapter, '', ok, signal)
    expect(summary(out.steps).slice(2)).toEqual(['auth:ok', 'write:ok', 'read:ok', 'delete:timeout'])
  })
})

describe('registryDeps', () => {
  it('saves a status patch onto the stored status, and ignores a destination that is gone', async () => {
    const t = await makeApp({ auth: true })
    try {
      const { ctx } = t.app
      const r = ctx.backup.destinations.create({
        name: 'Disk',
        type: 'folder',
        config: { path: join(base, 'root', 'deps') },
        secrets: {},
        policy: { encryptedOnly: true },
        createdBy: null,
      })
      ctx.backup.destinations.setStatus(r.id, { state: 'ok', checkedAt: 5, account: 'a@example.com' })
      const d = registryDeps(ctx)
      // Jobs keep the full retry policy: only routes pass retries.
      expect('retries' in d).toBe(false)
      expect(d.dataDir).toBe(ctx.config.dataDir)
      expect(d.tokens).toBe(ctx.backup.tokens)
      d.saveStatus(r.id, { folderId: 'folder-1' })
      expect(ctx.backup.destinations.get(r.id)!.status).toEqual({
        state: 'ok',
        checkedAt: 5,
        account: 'a@example.com',
        folderId: 'folder-1',
      })
      const gone = '22222222-2222-4222-8222-222222222222'
      expect(() => d.saveStatus(gone, { folderId: 'x' })).not.toThrow()
      expect(ctx.backup.destinations.get(gone)).toBeUndefined()
    } finally {
      await t.close()
    }
  })
})
