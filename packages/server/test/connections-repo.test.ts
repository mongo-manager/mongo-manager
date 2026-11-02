import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema, SECRET_MASK, type ConnectionInput } from '@mongo-manager/shared'
import { openStore, type Store } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'
import { ConnectionRepo, toConnectionDto } from '../src/connections/repo'

let dir: string
let store: Store
const clock = { now: 1_000 }
const box = createSecretBox(randomBytes(32))
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-conn-'))
  store = await openStore(dir)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const input = (name: string, password = 'hunter2-secret'): ConnectionInput => ({
  name,
  favorite: false,
  readOnly: false,
  aiPolicy: 'any',
  aiAgentWrites: true,
  aiAgentToolsOff: [],
  settings: ConnectionSettingsSchema.parse({
    hosts: [{ host: 'db.internal.example', port: 27017 }],
    auth: { mechanism: 'DEFAULT', username: 'app', password },
  }),
})

describe('ConnectionRepo', () => {
  it('creates the tables', () => {
    const names = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['connections', 'connection_grants']))
  })

  it('stores settings sealed, never in plaintext', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const c = repo.create(input('Prod'), null)
    const raw = store.db.prepare('SELECT settings FROM connections WHERE id = ?').get(c.id) as {
      settings: string
    }
    expect(raw.settings.startsWith('v1.')).toBe(true)
    expect(raw.settings).not.toContain('hunter2')
    expect(raw.settings).not.toContain('db.internal.example')
    expect(repo.get(c.id)?.settings.auth.password).toBe('hunter2-secret')
  })

  it('reads a stored timeoutMS back without it', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const c = repo.create(input('Old'), null)
    const stored = { ...input('Old').settings, options: { timeoutMS: '5000', maxPoolSize: '5' } }
    store.db
      .prepare('UPDATE connections SET settings = ? WHERE id = ?')
      .run(box.seal(JSON.stringify(stored), `connection:${c.id}:settings`), c.id)
    expect(repo.get(c.id)?.settings.options).toEqual({ maxPoolSize: '5' })
  })

  it('reads stored settings that hold no options at all', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const c = repo.create(input('Bare'), null)
    const { options: _none, ...stored } = input('Bare').settings
    store.db
      .prepare('UPDATE connections SET settings = ? WHERE id = ?')
      .run(box.seal(JSON.stringify(stored), `connection:${c.id}:settings`), c.id)
    expect(repo.get(c.id)?.settings.hosts).toEqual([{ host: 'db.internal.example', port: 27017 }])
    // The form reads options: settings stored with none have none.
    expect(repo.get(c.id)?.settings.options).toEqual({})
  })

  it('binds each sealed value to its row', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const a = repo.create(input('A'), null)
    const b = repo.create(input('B'), null)
    const sealedA = (
      store.db.prepare('SELECT settings FROM connections WHERE id = ?').get(a.id) as { settings: string }
    ).settings
    store.db.prepare('UPDATE connections SET settings = ? WHERE id = ?').run(sealedA, b.id)
    expect(() => repo.get(b.id)).toThrow(/decrypt/)
  })

  it('lists favourites first then by name, updates, touches and deletes', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const b = repo.create(input('beta'), 'u1')
    repo.create({ ...input('Alpha'), favorite: true }, null)
    repo.create(input('gamma'), null)
    expect(repo.list().map((c) => c.name)).toEqual(['Alpha', 'beta', 'gamma'])
    clock.now = 2_000
    const updated = repo.update(b.id, { name: 'Beta', group: 'Prod', color: 'red', readOnly: true })
    expect(updated).toMatchObject({
      name: 'Beta',
      group: 'Prod',
      color: 'red',
      readOnly: true,
      updatedAt: 2_000,
      createdBy: 'u1',
    })
    expect(repo.update(b.id, { group: null, color: null })).toMatchObject({ group: null, color: null })
    repo.touch(b.id)
    expect(repo.get(b.id)?.lastUsedAt).toBe(2_000)
    repo.setSshFingerprint(b.id, 'SHA256:abc', { host: 'bastion', port: 22 })
    expect(repo.get(b.id)?.settings.ssh).toBeUndefined()
    expect(repo.update('missing', { name: 'x' })).toBeUndefined()
    expect(repo.delete(b.id)).toBe(true)
    expect(repo.delete(b.id)).toBe(false)
    expect(repo.count()).toBe(2)
  })

  it('pins an SSH fingerprint only for SSH connections', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const c = repo.create(
      {
        ...input('Tunnel'),
        settings: ConnectionSettingsSchema.parse({
          hosts: [{ host: 'db' }],
          ssh: { enabled: true, host: 'bastion', username: 'u', method: 'password', password: 'p' },
        }),
      },
      null,
    )
    const dialled = repo.get(c.id)!.settings.ssh!
    repo.setSshFingerprint(c.id, 'SHA256:abc', dialled)
    expect(repo.get(c.id)?.settings.ssh?.hostFingerprint).toBe('SHA256:abc')
  })

  // Review of the open's stop (minor 6): a first use of the old SSH host that ends after an edit
  // pinned that host's key onto settings that point at another host, over the key pinned for it.
  it('pins a host key only onto the settings of the host it came from, and never over another', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const ssh = { enabled: true, host: 'bastion-a', username: 'u', method: 'password', password: 'p' }
    const c = repo.create(
      {
        ...input('Tunnel'),
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db' }], ssh }),
      },
      null,
    )
    const a = repo.get(c.id)!.settings.ssh!
    for (const moved of [{ host: 'bastion-b' }, { port: 2222 }]) {
      repo.update(c.id, {
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db' }], ssh: { ...ssh, ...moved } }),
      })
      repo.setSshFingerprint(c.id, 'SHA256:of-a', a)
      expect(repo.get(c.id)?.settings.ssh?.hostFingerprint).toBeUndefined()
    }
    // SSH turned off meanwhile: nothing is pinned onto settings that dial no tunnel.
    repo.update(c.id, {
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db' }], ssh: { ...ssh, enabled: false } }),
    })
    repo.setSshFingerprint(c.id, 'SHA256:of-a', a)
    expect(repo.get(c.id)?.settings.ssh?.hostFingerprint).toBeUndefined()
    // Another account on the same host: the same host key, kept as a form keeps it (withStoredPin).
    repo.update(c.id, {
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db' }], ssh: { ...ssh, username: 'v' } }),
    })
    repo.setSshFingerprint(c.id, 'SHA256:of-a', a)
    expect(repo.get(c.id)?.settings.ssh?.hostFingerprint).toBe('SHA256:of-a')
    const b = { ...ssh, host: 'bastion-b', hostFingerprint: 'SHA256:of-b' }
    repo.update(c.id, { settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'db' }], ssh: b }) })
    repo.setSshFingerprint(c.id, 'SHA256:other', repo.get(c.id)!.settings.ssh!)
    expect(repo.get(c.id)?.settings.ssh?.hostFingerprint).toBe('SHA256:of-b')
  })

  it('renders a DTO with masked secrets and a credential-free URI', () => {
    const repo = new ConnectionRepo(store.db, box, () => clock.now)
    const dto = toConnectionDto(repo.create(input('Prod'), 'u1'))
    expect(dto.settings.auth.password).toBe(SECRET_MASK)
    expect(dto.uri).toBe('mongodb://db.internal.example:27017/')
    expect(JSON.stringify(dto)).not.toContain('hunter2')
    expect('createdBy' in dto).toBe(false)
  })
})
