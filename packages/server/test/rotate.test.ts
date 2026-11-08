// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { KEY_FILE, createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { finishPendingRotation, keyFingerprint, rotateSecretKey, verifyKeyCheck } from '../src/crypto/rotate'
import { ConnectionRepo } from '../src/connections/repo'
import { UserRepo } from '../src/auth/users'
import { acquireInstanceLock } from '../src/store/lock'
import { PluginRepo } from '../src/plugins/repo'
import { AlertRepo } from '../src/alerts/repo'
import { OidcTokenRepo } from '../src/oidc/tokens'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-rotate-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const posix = process.platform !== 'win32'
const SETTINGS = {
  hosts: [{ host: 'db.internal', port: 27017 }],
  auth: { mechanism: 'DEFAULT', username: 'app', password: 's3cret-pw' },
}

/** A data directory with one connection and one TOTP secret sealed with the file key. */
async function seeded() {
  const dir = tempDir()
  const key = loadOrCreateKey({ dataDir: dir })
  const box = createSecretBox(key)
  const store = await openStore(dir)
  const conn = new ConnectionRepo(store.db, box, Date.now).create(
    { name: 'Prod', settings: SETTINGS } as never,
    null,
  )
  const users = new UserRepo(store.db, Date.now)
  const user = users.create({ username: 'ada', passwordHash: 'x', role: 'admin' })
  users.setTotp(user.id, box.seal('JBSWY3DPEHPK3PXP', `totp:${user.id}`), true)
  verifyKeyCheck(store.db, box)
  store.close()
  return { dir, key, connId: conn.id, userId: user.id }
}

function sealedValues(dir: string, connId: string, userId: string) {
  // Read raw columns through a fresh store.
  return openStore(dir).then((store) => {
    const settings = (
      store.db.prepare('SELECT settings FROM connections WHERE id = ?').get(connId) as { settings: string }
    ).settings
    const totp = (
      store.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as { totp_secret: string }
    ).totp_secret
    store.close()
    return { settings, totp }
  })
}

describe('rotate-key (Review Focus 1)', () => {
  it('re-encrypts every secret with a new key file and keeps a backup and the old key', async () => {
    const { dir, key, connId, userId } = await seeded()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result).toMatchObject({ connections: 1, totpSecrets: 1, keyFile: join(dir, KEY_FILE) })
    const newKey = loadOrCreateKey({ dataDir: dir })
    expect(newKey.equals(key)).toBe(false)
    const { settings, totp } = await sealedValues(dir, connId, userId)
    const box = createSecretBox(newKey)
    expect(JSON.parse(box.open(settings, `connection:${connId}:settings`)).auth.password).toBe('s3cret-pw')
    expect(box.open(totp, `totp:${userId}`)).toBe('JBSWY3DPEHPK3PXP')
    expect(() => createSecretBox(key).open(totp, `totp:${userId}`)).toThrow()
    expect(existsSync(result.backupPath)).toBe(true)
    expect(result.oldKeyFile && readFileSync(result.oldKeyFile, 'utf8').trim()).toBe(key.toString('base64'))
    expect(existsSync(join(dir, `${KEY_FILE}.new`))).toBe(false)
    if (posix) {
      for (const f of [result.backupPath, result.keyFile, result.oldKeyFile!])
        expect(statSync(f).mode & 0o777).toBe(0o600)
    }
  })

  // Security audit 2026-10-16 (minor): plugins' settings are sealed now, so a rotation re-seals them.
  it('re-seals plugins’ settings', async () => {
    const { dir, key } = await seeded()
    const store = await openStore(dir)
    const repo = new PluginRepo(store.db, () => 1, createSecretBox(key))
    repo.put({
      id: 'maps',
      source: 'upload',
      manifest: null,
      digest: null,
      files: {},
      bytes: 0,
      error: null,
      enabled: false,
      approvedPermissions: [],
      approvedDigest: null,
      settings: { tileUrl: 'https://t.example.org/{z}.png?token=T0K' },
      installedBy: null,
      installedAt: 1,
      updatedFrom: null,
      scan: null,
      origin: null,
      approvalCarried: false,
    })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.pluginSettings).toBe(1)
    const after = await openStore(dir)
    const reopened = new PluginRepo(after.db, () => 1, createSecretBox(loadOrCreateKey({ dataDir: dir })))
    expect(reopened.get('maps')!.settings).toEqual({ tileUrl: 'https://t.example.org/{z}.png?token=T0K' })
    after.close()
  })

  // W3.3: the SMTP password and webhook signing secrets are sealed with the key.
  it('re-seals the alert channels’ secrets', async () => {
    const { dir, key } = await seeded()
    const store = await openStore(dir)
    const repo = new AlertRepo(store.db, createSecretBox(key), () => 1)
    repo.setSmtp({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      username: 'mailer',
      password: 'smtp-pass-rotated',
      from: 'a@example.com',
      recipients: ['b@example.com'],
    })
    const hook = repo.createWebhook({ name: 'Ops', url: 'https://hooks.example.com/x', enabled: true })
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.alertChannels).toBe(2)
    const after = await openStore(dir)
    const reopened = new AlertRepo(after.db, createSecretBox(loadOrCreateKey({ dataDir: dir })), () => 1)
    expect(reopened.smtp()!.password).toBe('smtp-pass-rotated')
    expect(reopened.webhookSecret(hook.id)).toBe(hook.secret)
    after.close()
  })

  // W7: people's OIDC tokens are sealed with the key.
  it('re-seals the OIDC tokens', async () => {
    const { dir, key, connId } = await seeded()
    const store = await openStore(dir)
    new OidcTokenRepo(store.db, createSecretBox(key), () => 1).put(
      connId,
      'local',
      { issuer: 'https://idp.example', clientId: 'c' },
      { accessToken: 'at-rotated', refreshToken: 'rt-rotated', expiresAt: 5 },
    )
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.oidcTokens).toBe(1)
    const after = await openStore(dir)
    const reopened = new OidcTokenRepo(after.db, createSecretBox(loadOrCreateKey({ dataDir: dir })), () => 1)
    expect(reopened.get(connId, 'local')).toMatchObject({
      accessToken: 'at-rotated',
      refreshToken: 'rt-rotated',
    })
    after.close()
  })

  it('refuses while a server holds the data directory (Review Focus 3)', async () => {
    const { dir } = await seeded()
    const lock = acquireInstanceLock(dir)
    try {
      await expect(rotateSecretKey({ dataDir: dir })).rejects.toThrow(/in use by Mongo Manager \(server/)
    } finally {
      lock.release()
    }
  })

  it('changes nothing when a secret cannot be decrypted', async () => {
    const { dir, key, connId, userId } = await seeded()
    const store = await openStore(dir)
    store.db.prepare("UPDATE users SET totp_secret = 'v1.AAAA.BBBB.CCCC' WHERE id = ?").run(userId)
    store.close()
    const before = await sealedValues(dir, connId, userId)
    await expect(rotateSecretKey({ dataDir: dir })).rejects.toThrow(/decrypt/)
    expect(await sealedValues(dir, connId, userId)).toEqual(before)
    expect(loadOrCreateKey({ dataDir: dir }).equals(key)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.startsWith(`${KEY_FILE}.`))).toEqual([])
  })

  it('needs a target file for the new key when the key comes from MM_SECRET_KEY', async () => {
    const dir = tempDir()
    const envKey = randomBytes(32).toString('base64')
    const store = await openStore(dir)
    verifyKeyCheck(store.db, createSecretBox(Buffer.from(envKey, 'base64')))
    store.close()
    await expect(rotateSecretKey({ dataDir: dir, envKey })).rejects.toThrow(/--new-key-file/)
    const target = join(tempDir(), 'new.key')
    const result = await rotateSecretKey({ dataDir: dir, envKey, newKeyFile: target })
    expect(result.keyFile).toBe(target)
    const next = readFileSync(target, 'utf8').trim()
    const check = await openStore(dir)
    expect(() => verifyKeyCheck(check.db, createSecretBox(Buffer.from(next, 'base64')))).not.toThrow()
    expect(() => verifyKeyCheck(check.db, createSecretBox(Buffer.from(envKey, 'base64')))).toThrow(
      /does not match/,
    )
    check.close()
  })
})

describe('interrupted rotation', () => {
  it('completes the swap when the database already uses the new key', async () => {
    const { dir } = await seeded()
    const next = randomBytes(32)
    writeFileSync(join(dir, `${KEY_FILE}.new`), `${next.toString('base64')}\n`, { mode: 0o600 })
    const store = await openStore(dir)
    store.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('key_rotation', ?)")
      .run(keyFingerprint(next))
    expect(finishPendingRotation(dir, store.db)).toBe('completed')
    store.close()
    expect(loadOrCreateKey({ dataDir: dir }).equals(next)).toBe(true)
    expect(readdirSync(dir).some((f) => f.startsWith(`${KEY_FILE}.old-`))).toBe(true)
  })

  it('sets aside, never deletes, a new key the database never switched to (Review Important 4)', async () => {
    const { dir, key } = await seeded()
    const unused = randomBytes(32).toString('base64')
    writeFileSync(join(dir, `${KEY_FILE}.new`), `${unused}\n`, { mode: 0o600 })
    const store = await openStore(dir)
    expect(finishPendingRotation(dir, store.db)).toBe('discarded')
    store.close()
    expect(loadOrCreateKey({ dataDir: dir }).equals(key)).toBe(true)
    expect(existsSync(join(dir, `${KEY_FILE}.new`))).toBe(false)
    const kept = readdirSync(dir).filter((f) => f.startsWith(`${KEY_FILE}.new.discarded-`))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]!), 'utf8').trim()).toBe(unused)
  })

  it('refuses to start with a key that does not match the data', async () => {
    const { dir } = await seeded()
    const config = resolveConfig({
      cli: { dataDir: dir, webPort: 0, logLevel: 'silent', secretKey: randomBytes(32).toString('base64') },
    })
    await expect(startServer(config)).rejects.toThrow(/does not match/)
    await (
      await startServer(resolveConfig({ cli: { dataDir: dir, webPort: 0, logLevel: 'silent' } }))
    ).close()
  })
})

describe('key check on an existing data directory', () => {
  it('is not created from a wrong key when older secrets exist', async () => {
    const dir = tempDir()
    const key = loadOrCreateKey({ dataDir: dir })
    const store = await openStore(dir)
    new ConnectionRepo(store.db, createSecretBox(key), Date.now).create(
      { name: 'Prod', settings: SETTINGS } as never,
      null,
    )
    // A data directory from before the key check existed.
    store.db.prepare("DELETE FROM settings WHERE key = 'key_check'").run()
    const wrong = createSecretBox(randomBytes(32))
    expect(() => verifyKeyCheck(store.db, wrong)).toThrow(/does not match/)
    expect(store.db.prepare("SELECT 1 FROM settings WHERE key = 'key_check'").get()).toBeUndefined()
    expect(() => verifyKeyCheck(store.db, createSecretBox(key))).not.toThrow()
    expect(store.db.prepare("SELECT 1 FROM settings WHERE key = 'key_check'").get()).toBeDefined()
    store.close()
  })
})

describe('rotation hardening (review fixes)', () => {
  it('names the key files it finds when the key does not match', async () => {
    const { dir } = await seeded()
    await rotateSecretKey({ dataDir: dir })
    const config = resolveConfig({
      cli: { dataDir: dir, webPort: 0, logLevel: 'silent', secretKey: randomBytes(32).toString('base64') },
    })
    await expect(startServer(config)).rejects.toThrow(/Key files found in .*secret\.key\.old-/s)
  })

  it('uses --new-key-file only with a configured key (Review Minor 3)', async () => {
    const { dir } = await seeded()
    await expect(rotateSecretKey({ dataDir: dir, newKeyFile: join(tempDir(), 'k') })).rejects.toThrow(
      /only used when the key is configured/,
    )
  })

  it('leaves no old ciphertext in the live database files, not even of deleted rows (Review Minor 8)', async () => {
    const { dir, key } = await seeded()
    const store = await openStore(dir)
    // A connection deleted before the rotation leaves its old-key ciphertext in free pages.
    const repo = new ConnectionRepo(store.db, createSecretBox(key), Date.now)
    const gone = repo.create({ name: 'Old', settings: SETTINGS } as never, null)
    const old = (
      store.db.prepare('SELECT settings FROM connections WHERE id = ?').get(gone.id) as { settings: string }
    ).settings
    repo.delete(gone.id)
    store.close()
    const marker = Buffer.from(old.split('.').at(-1)!.slice(0, 40))
    const live = () =>
      readdirSync(dir).filter((f) => f.startsWith('mongo-manager.db') && !f.includes('.bak-'))
    expect(live().some((f) => readFileSync(join(dir, f)).includes(marker))).toBe(true)
    await rotateSecretKey({ dataDir: dir })
    for (const file of live()) expect(readFileSync(join(dir, file)).includes(marker), file).toBe(false)
  })
})
