import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { SftpConfigSchema, SftpSecretsSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createSftpAdapter } from '../src/backup/destinations/sftp'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import ssh2 from 'ssh2'
import { sshKeyPair } from './support/ssh-server'
import { startSftpServer, type TestSftpServer } from './support/sftp-server'
import { slow } from './support/slowness'

/** W4 item 5 (completion design §2 W4.5): SFTP as a backup destination, its host key pinned. */
let srv: TestSftpServer
let root: string
let dir: string
const signal = new AbortController().signal
const KiB = 1024
const client = sshKeyPair()
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mm-sftp-root-'))
  dir = mkdtempSync(join(tmpdir(), 'mm-sftp-'))
  srv = await startSftpServer({ root, password: 'pw-1', publicKey: client.public })
})
afterAll(async () => {
  await srv?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  for (const e of readdirSync(root)) rmSync(join(root, e), { recursive: true, force: true })
  mkdirSync(join(root, 'backups'))
  srv.dropAfter = null
  srv.stallReads = false
})

const egress = createEgress({ networks: ['127.0.0.1/32'] })
function adapter(
  over: Record<string, unknown> = {},
  secrets: Record<string, string> = { password: 'pw-1' },
  extra: { retries?: number; stallMs?: number } = {},
) {
  return createSftpAdapter({
    egress,
    config: SftpConfigSchema.parse({
      host: '127.0.0.1',
      port: srv.port,
      username: 'backup',
      folder: '/backups',
      auth: secrets.privateKey ? 'privateKey' : 'password',
      hostFingerprint: srv.fingerprint,
      ...over,
    }),
    secrets,
    partBytes: 64 * KiB,
    now: () => Date.now(),
    retries: 0,
    ...extra,
  })
}
function file(size: number) {
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i++) body[i] = (i * 31) % 251
  const path = join(dir, `f-${size}-${Math.random()}`)
  writeFileSync(path, body)
  return {
    body,
    local: {
      path,
      size,
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('hex'),
    },
  }
}
const key = () => remoteKeyFor('', 'mmbak', randomUUID(), Date.UTC(2026, 9, 16))
const io = (saved: Array<ResumeState | null> = [], sent: number[] = []) => ({
  progress: (n: number) => sent.push(n),
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})

describe('SFTP destination, W4 review minors', () => {
  it('names an IPv6 server in brackets', () => {
    expect(adapter({ host: '::1' }).endpoint()!.href).toBe(`sftp://[::1]:${srv.port}`)
  })

  it(
    'goes on from what the part file holds when it retries within one send',
    async () => {
      const k = key()
      const f = file(400 * KiB)
      srv.dropAfter = 150 * KiB
      const before = srv.written
      await adapter({}, undefined, { retries: 1 }).put(k, f.local, null, io(), signal)
      expect(readFileSync(join(root, 'backups', k)).equals(f.body)).toBe(true)
      // Not sent twice from the start.
      expect(srv.written - before).toBeLessThan(f.body.length + 100 * KiB)
    },
    slow(30_000),
  )

  it('starts again over a part file larger than the backup, or one that is not its beginning', async () => {
    const f = file(200 * KiB)
    const k1 = key()
    mkdirSync(join(root, 'backups', k1, '..'), { recursive: true })
    writeFileSync(join(root, 'backups', `${k1}.part`), Buffer.alloc(300 * KiB, 1))
    await adapter().put(k1, f.local, { key: k1 }, io(), signal)
    expect(readFileSync(join(root, 'backups', k1)).equals(f.body)).toBe(true)
    // Reading back off: a resumed part is still checked, as far as it goes.
    const k2 = key()
    writeFileSync(join(root, 'backups', `${k2}.part`), Buffer.alloc(100 * KiB, 7))
    await adapter({ verifyReadBack: false }).put(k2, f.local, { key: k2 }, io(), signal)
    expect(readFileSync(join(root, 'backups', k2)).equals(f.body)).toBe(true)
  })

  it('replaces a small object at once where the server can (posix-rename)', async () => {
    const proto = ssh2.Client.prototype as unknown as { sftp: (cb: (e: unknown, s: unknown) => void) => void }
    const orig = proto.sftp
    proto.sftp = function (this: unknown, cb) {
      return orig.call(this, (e: unknown, s: unknown) => {
        if (s) (s as { _extensions: Record<string, string> })._extensions['posix-rename@openssh.com'] = '1'
        cb(e, s)
      })
    }
    try {
      const a = adapter()
      const k = 'mongo-manager/manifest.json'
      await a.putSmall(k, Buffer.from('one'), signal)
      await a.putSmall(k, Buffer.from('two'), signal)
      expect(readFileSync(join(root, 'backups', k), 'utf8')).toBe('two')
      expect(srv.removed.filter((r) => r.endsWith('manifest.json'))).toEqual([])
      expect(srv.posixRenamed.filter((r) => r.endsWith('manifest.json'))).toHaveLength(2)
    } finally {
      proto.sftp = orig
    }
  })

  it('a caller who stops does not stop the session others wait for', async () => {
    const a = adapter()
    const ctl = new AbortController()
    const first = a.stat('nothing/here', ctl.signal)
    const second = a.stat('nothing/there', signal)
    ctl.abort()
    await expect(first).rejects.toBeTruthy()
    await expect(second).resolves.toBeNull()
  })

  it('gives up on a read that stalls', async () => {
    const k = key()
    const f = file(100 * KiB)
    await adapter().put(k, f.local, null, io(), signal)
    srv.stallReads = true
    const stream = await adapter({}, undefined, { stallMs: 300 }).get(k, 0, signal)
    await expect(buffer(stream)).rejects.toMatchObject({ reason: 'timeout' })
  })
})

describe('SFTP destination (W4.5)', () => {
  it('signs in with a password or a key, only to the pinned host key', async () => {
    expect(await adapter().authCheck(signal)).toEqual({})
    expect(await adapter({}, { privateKey: client.private }).authCheck(signal)).toEqual({})
    await expect(adapter({}, { password: 'wrong' }).authCheck(signal)).rejects.toMatchObject({
      reason: 'auth',
    })
    // No key pinned yet: nothing is sent, and the key shown is said back to be compared.
    const unpinned = await adapter({ hostFingerprint: undefined })
      .authCheck(signal)
      .catch((e: { reason: string; extra: { hostKey?: string } }) => e)
    expect(unpinned).toMatchObject({ reason: 'host_key', extra: { hostKey: srv.fingerprint } })
    const other = `SHA256:${'A'.repeat(43)}`
    await expect(adapter({ hostFingerprint: other }).authCheck(signal)).rejects.toMatchObject({
      reason: 'host_key_changed',
      extra: { hostKey: srv.fingerprint },
    })
  })

  it('probes the address through the egress guard (resolve and connect steps)', async () => {
    const t = await adapter().probe!(signal)
    expect(t.connectMs).toBeGreaterThanOrEqual(0)
    const closed = createSftpAdapter({
      egress: createEgress({ networks: [] }),
      config: SftpConfigSchema.parse({
        host: '127.0.0.1',
        port: srv.port,
        username: 'backup',
        auth: 'password',
      }),
      secrets: { password: 'pw-1' },
      partBytes: 64 * KiB,
      now: () => Date.now(),
    })
    await expect(closed.probe!(signal)).rejects.toMatchObject({ reason: 'address_refused' })
    await expect(closed.authCheck(signal)).rejects.toMatchObject({ reason: 'address_refused' })
  })

  it('uploads into a part file renamed when whole, makes the folders, and reads back from an offset', async () => {
    const k = key()
    const f = file(300 * KiB)
    const sent: number[] = []
    await adapter().put(k, f.local, null, io([], sent), signal)
    expect(readFileSync(join(root, 'backups', k)).equals(f.body)).toBe(true)
    expect(existsSync(join(root, 'backups', `${k}.part`))).toBe(false)
    expect(sent.at(-1)).toBe(f.body.length)
    expect(await adapter().stat(k, signal)).toEqual({ size: f.body.length, archived: false })
    const tail = await buffer(await adapter().get(k, 1000, signal))
    expect(tail.equals(f.body.subarray(1000))).toBe(true)
    expect(adapter().readBack).toBe(true)
    expect(adapter({ verifyReadBack: false }).readBack).toBe(false)
  })

  it('resumes an interrupted upload from the part file', async () => {
    const k = key()
    const f = file(400 * KiB)
    const saved: Array<ResumeState | null> = []
    srv.dropAfter = 150 * KiB
    await expect(adapter().put(k, f.local, null, io(saved), signal)).rejects.toBeTruthy()
    const before = srv.written
    await adapter().put(k, f.local, saved.filter(Boolean).at(-1)!, io(), signal)
    expect(readFileSync(join(root, 'backups', k)).equals(f.body)).toBe(true)
    // Only what was missing went up again.
    expect(srv.written - before).toBeLessThan(f.body.length)
  })

  it('writes small objects, removes, abandons a part, and lists only the layout newest first', async () => {
    const a = adapter()
    const keys = [key(), key(), key()]
    for (const k of keys) await a.putSmall(k, Buffer.from('x'), signal)
    await a.putSmall(`${keys[0]}.json`, Buffer.from('{}'), signal)
    expect((await a.getSmall(`${keys[0]}.json`, 64, signal))!.toString()).toBe('{}')
    expect(await a.getSmall('mongo-manager/2026/10/mm-20261016-000000-00000000.mmbak', 64, signal)).toBeNull()
    writeFileSync(join(root, 'backups', 'mongo-manager', '2026', '10', 'notes.txt'), 'x')
    writeFileSync(
      join(root, 'backups', 'mongo-manager', '2026', '10', `${keys[1]!.split('/').at(-1)}.part`),
      'x',
    )
    expect((await a.list(null, signal)).items.map((i) => i.key)).toEqual([...keys].sort().reverse())
    await a.remove(keys[0]!, signal)
    await a.remove(keys[0]!, signal)
    expect(await a.stat(keys[0]!, signal)).toBeNull()
    await a.abandon({ key: keys[1]! }, signal)
    expect(existsSync(join(root, 'backups', `${keys[1]}.part`))).toBe(false)
  })

  it('reuses one session for many calls, and refuses keys and settings that would leave the folder', async () => {
    const a = adapter()
    const before = srv.sessions
    for (let i = 0; i < 5; i++) await a.stat(key(), signal)
    expect(srv.sessions - before).toBe(1)
    await expect(a.putSmall('../../etc/passwd', Buffer.from('x'), signal)).rejects.toMatchObject({
      reason: 'path',
    })
    await expect(a.abandon({ key: '../../etc/passwd' }, signal)).resolves.toBeUndefined()
    for (const bad of ['../etc', '/a/../b', 'a//b'])
      expect(
        SftpConfigSchema.safeParse({ host: 'h', username: 'u', auth: 'password', folder: bad }).success,
        bad,
      ).toBe(false)
    for (const bad of ['user@host', 'host/path', 'a'.repeat(64), `${'a'.repeat(5000)}!`, 'host:22'])
      expect(SftpConfigSchema.safeParse({ host: bad, username: 'u', auth: 'password' }).success, bad).toBe(
        false,
      )
    expect(SftpSecretsSchema.safeParse({ privateKey: 'not a key' }).success).toBe(false)
  })
})
