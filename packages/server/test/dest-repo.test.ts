import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { CopyRepo, DestinationRepo } from '../src/backup/destinations/repo'
import { UserRepo } from '../src/auth/users'
import type { Principal } from '../src/http/context'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-dest-repo-'))
  dirs.push(dir)
  const store = await openStore(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const now = () => 1_000
  return {
    dir,
    store,
    box,
    repo: new DestinationRepo(store.db, box, now),
    copies: new CopyRepo(store.db, box, now),
    users: new UserRepo(store.db, now),
  }
}
const S3 = {
  preset: 'aws',
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  bucket: 'acme',
  prefix: '',
  pathStyle: false,
  storageClass: 'STANDARD',
  sse: { kind: 'none' },
}
const policy = { encryptedOnly: true }

describe('destination repository (phase 3d-3b spec §4.1, §4.4, D4–D6)', () => {
  it('seals secrets and never lists them', async () => {
    const { store, repo } = await setup()
    try {
      const d = repo.create({
        name: 'Offsite',
        type: 's3',
        config: S3,
        secrets: { accessKeyId: 'AKIAEXAMPLE1234', secretAccessKey: 'SENTINEL-SECRET-VALUE' },
        policy,
        createdBy: null,
      })
      const raw = JSON.stringify(store.db.prepare('SELECT * FROM backup_destinations').all())
      expect(raw).not.toContain('SENTINEL-SECRET-VALUE')
      expect(raw).not.toContain('AKIAEXAMPLE1234')
      expect(repo.get(d.id)!.secretFields.sort()).toEqual(['accessKeyId', 'secretAccessKey'])
      expect(JSON.stringify(repo.list())).not.toContain('SENTINEL')
      expect(repo.secrets(d.id).secretAccessKey).toBe('SENTINEL-SECRET-VALUE')
      expect(() =>
        repo.create({
          name: 'offsite',
          type: 's3',
          config: S3,
          secrets: { accessKeyId: 'a', secretAccessKey: 'b' },
          policy,
          createdBy: null,
        }),
      ).toThrow(/name/)
    } finally {
      store.close()
    }
  })

  it('keeps secrets on an edit without them, and requires them all when the identity changes', async () => {
    const { store, repo } = await setup()
    try {
      const d = repo.create({
        name: 'Offsite',
        type: 's3',
        config: S3,
        secrets: { accessKeyId: 'AKIAEXAMPLE1234', secretAccessKey: 'one-secret-value' },
        policy,
        createdBy: null,
      })
      const renamed = repo.update(d.id, { name: 'Renamed', config: { ...S3, storageClass: 'STANDARD_IA' } })
      expect(renamed.identityChanged).toBe(false)
      expect(repo.secrets(d.id).secretAccessKey).toBe('one-secret-value')
      expect(() => repo.update(d.id, { config: { ...S3, endpoint: 'https://evil.example.com' } })).toThrow(
        /credentials again/,
      )
      expect(() =>
        repo.update(d.id, {
          config: { ...S3, bucket: 'other' },
          secrets: { secretAccessKey: 'x-secret-value' },
        }),
      ).toThrow(/credentials again/)
      const moved = repo.update(d.id, {
        config: { ...S3, bucket: 'other' },
        secrets: { accessKeyId: 'AKIAEXAMPLE9999', secretAccessKey: 'two-secret-value' },
      })
      expect(moved.identityChanged).toBe(true)
      expect(repo.secrets(d.id)).toEqual({
        accessKeyId: 'AKIAEXAMPLE9999',
        secretAccessKey: 'two-secret-value',
      })
    } finally {
      store.close()
    }
  })

  it('grants levels to users and reports who lost access', async () => {
    const { store, repo, users } = await setup()
    try {
      const a = users.create({ username: 'alice', passwordHash: 'x', role: 'editor' })
      const b = users.create({ username: 'bob', passwordHash: 'x', role: 'viewer' })
      const d = repo.create({
        name: 'Disk',
        type: 'folder',
        config: { path: '/srv/x' },
        secrets: {},
        policy,
        createdBy: null,
      })
      repo.setGrants(d.id, [
        { userId: a.id, level: 'browse' },
        { userId: b.id, level: 'send' },
      ])
      const editor = { kind: 'user', userId: a.id, role: 'editor' } as unknown as Principal
      const viewer = { kind: 'user', userId: b.id, role: 'viewer' } as unknown as Principal
      const admin = { kind: 'local', userId: 'local', role: 'admin' } as unknown as Principal
      expect(repo.levelOf(d.id, editor)).toBe('browse')
      expect(repo.levelOf(d.id, viewer)).toBe('send')
      expect(repo.levelOf(d.id, admin)).toBe('admin')
      expect(repo.grants(d.id).map((g) => g.username)).toEqual(['alice', 'bob'])
      // Lowering browse to send loses something too: the other users' files.
      expect(repo.setGrants(d.id, [{ userId: a.id, level: 'send' }]).lost.sort()).toEqual([a.id, b.id].sort())
      expect(repo.levelOf(d.id, viewer)).toBeNull()
      expect(repo.levelOf('missing', admin)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('tracks copies with sealed resume states', async () => {
    const { store, repo, copies } = await setup()
    try {
      const d = repo.create({
        name: 'Disk',
        type: 'folder',
        config: { path: '/srv/x' },
        secrets: {},
        policy,
        createdBy: null,
      })
      const c = copies.create({
        destinationId: d.id,
        backupId: 'b1',
        remoteKey: 'mongo-manager/2026/10/mm-20261003-143005-7c9e6679.mmbak',
        owner: 'u1',
        connectionId: 'c1',
        meta: null,
        format: 'mmbak',
        size: 10,
        sha256: 'a'.repeat(64),
        md5: null,
      })
      copies.setResume(c.id, { uploadId: 'SENTINEL-UPLOAD-ID', parts: [] })
      expect(JSON.stringify(store.db.prepare('SELECT * FROM backup_remote_copies').all())).not.toContain(
        'SENTINEL-UPLOAD-ID',
      )
      expect(copies.resume(c.id)).toEqual({ uploadId: 'SENTINEL-UPLOAD-ID', parts: [] })
      copies.setSent(c.id, 5)
      copies.complete(c.id, 'ref-1')
      expect(copies.get(c.id)).toMatchObject({ state: 'complete', sent: 10, remoteRef: 'ref-1' })
      expect(copies.resume(c.id)).toBeNull()
      expect(copies.forBackupOn('b1', d.id)?.id).toBe(c.id)
      copies.detachBackup('b1')
      expect(copies.get(c.id)!.backupId).toBeNull()
      expect(repo.usage(d.id)).toEqual({ copies: 1, bytes: 10 })
    } finally {
      store.close()
    }
  })

  it('re-seals destinations and resume states on key rotation (D6)', async () => {
    const { dir, store, repo, copies } = await setup()
    const d = repo.create({
      name: 'Offsite',
      type: 's3',
      config: S3,
      secrets: { accessKeyId: 'AKIAEXAMPLE1234', secretAccessKey: 'rotate-me-secret' },
      policy,
      createdBy: null,
    })
    const c = copies.create({
      destinationId: d.id,
      backupId: null,
      remoteKey: 'k',
      owner: 'u',
      connectionId: null,
      meta: null,
      format: 'mmbak',
      size: 1,
      sha256: 'b'.repeat(64),
      md5: null,
    })
    copies.setResume(c.id, { session: 'https://www.googleapis.com/upload?upload_id=abc' })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result).toMatchObject({ backupDestinations: 1, backupCopies: 1 })
    const reopened = await openStore(dir)
    try {
      const box = createSecretBox(Buffer.from(readFileSync(join(dir, 'secret.key'), 'utf8').trim(), 'base64'))
      expect(new DestinationRepo(reopened.db, box, () => 0).secrets(d.id).secretAccessKey).toBe(
        'rotate-me-secret',
      )
      expect(new CopyRepo(reopened.db, box, () => 0).resume(c.id)).toEqual({
        session: 'https://www.googleapis.com/upload?upload_id=abc',
      })
    } finally {
      reopened.close()
    }
  })
})
