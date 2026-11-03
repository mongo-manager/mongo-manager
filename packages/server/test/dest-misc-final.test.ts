import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { DestinationRepo, identityOf } from '../src/backup/destinations/repo'
import { DestinationSlots } from '../src/backup/destinations/slots'
import { DeviceFlows } from '../src/backup/destinations/device-flows'
import { startDeviceFlow } from '../src/backup/destinations/google-auth'
import type { Egress } from '../src/net/egress'

/* Phase 3d-3b final review: repository identity and lazy secrets, slots, device flows. */

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-dest-final-'))
  dirs.push(dir)
  const store = await openStore(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  let opens = 0
  const counting = {
    ...box,
    seal: box.seal.bind(box),
    open: (...a: Parameters<typeof box.open>) => {
      opens++
      return box.open(...a)
    },
  } as typeof box
  return { store, repo: new DestinationRepo(store.db, counting, () => 1_000), opens: () => opens }
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
const DAV = { preset: 'generic', url: 'https://dav.example.test/dav', folder: '', username: 'ops' }
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBattacker\n-----END CERTIFICATE-----'

describe('destination identity (A8)', () => {
  it('a CA certificate is part of the identity of S3 and WebDAV destinations', () => {
    expect(identityOf('s3', S3)).not.toBe(identityOf('s3', { ...S3, caPem: PEM }))
    expect(identityOf('webdav', DAV)).not.toBe(identityOf('webdav', { ...DAV, caPem: PEM }))
    expect(identityOf('webdav', { ...DAV, caPem: PEM })).not.toBe(
      identityOf('webdav', { ...DAV, caPem: `${PEM}\n` }),
    )
    // The certificate itself is not spelled out in the identity.
    expect(identityOf('s3', { ...S3, caPem: PEM })).not.toContain('MIIB')
  })

  it('adding a CA without the password again is refused (it could redirect Basic credentials)', async () => {
    const { store, repo } = await setup()
    try {
      const d = repo.create({
        name: 'Dav',
        type: 'webdav',
        config: DAV,
        secrets: { password: 'pw' },
        policy: { encryptedOnly: true },
        createdBy: null,
      })
      expect(() => repo.update(d.id, { config: { ...DAV, caPem: PEM } })).toThrow(/credentials/i)
      expect(
        repo.update(d.id, { config: { ...DAV, caPem: PEM }, secrets: { password: 'pw' } }).identityChanged,
      ).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('lazy secrets (A28)', () => {
  it('lists and gets without decrypting, and a corrupt sealed value does not break the list', async () => {
    const { store, repo, opens } = await setup()
    try {
      const d = repo.create({
        name: 'Offsite',
        type: 's3',
        config: S3,
        secrets: { accessKeyId: 'AKIAEXAMPLE1234', secretAccessKey: 'secret' },
        policy: { encryptedOnly: true },
        createdBy: null,
      })
      const before = opens()
      repo.list()
      repo.get(d.id)
      expect(opens()).toBe(before)
      store.db.prepare('UPDATE backup_destinations SET secrets = ? WHERE id = ?').run('corrupt', d.id)
      expect(repo.list().map((r) => r.id)).toEqual([d.id])
      expect(repo.get(d.id)!.secretFields).toEqual([])
      expect(() => repo.secrets(d.id)).toThrow()
      // An administrator repairs it by entering the credentials again.
      repo.update(d.id, { secrets: { accessKeyId: 'AKIAEXAMPLE5678', secretAccessKey: 's2' } })
      expect(repo.secrets(d.id).accessKeyId).toBe('AKIAEXAMPLE5678')
      expect(repo.get(d.id)!.secretFields).toEqual(['accessKeyId', 'secretAccessKey'])
    } finally {
      store.close()
    }
  })
})

describe('destination slots (A23)', () => {
  it('refuses an already-aborted signal at once', async () => {
    const slots = new DestinationSlots(1)
    const release = await slots.acquire('d', new AbortController().signal)
    const ac = new AbortController()
    ac.abort(new Error('gone'))
    let settled = false
    const p = slots.acquire('d', ac.signal).then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(true)
    await p
    release()
    expect(slots.inUse('d')).toBe(0)
  })

  it('hands a released slot to the waiter: a synchronous acquire cannot slip past the limit', async () => {
    const slots = new DestinationSlots(1)
    const signal = new AbortController().signal
    const first = await slots.acquire('d', signal)
    let waiterGot = false
    const waiter = slots.acquire('d', signal).then((r) => {
      waiterGot = true
      return r
    })
    await new Promise((r) => setTimeout(r, 5))
    first()
    // In the same tick, someone else asks: they must wait, the slot is the waiter's.
    let thirdGot = false
    const third = slots.acquire('d', signal).then((r) => {
      thirdGot = true
      return r
    })
    const second = await waiter
    expect(waiterGot).toBe(true)
    expect(thirdGot).toBe(false)
    expect(slots.inUse('d')).toBe(1)
    second()
    const last = await third
    expect(slots.inUse('d')).toBe(1)
    last()
    expect(slots.inUse('d')).toBe(0)
  })
})

describe('device flows (A24)', () => {
  it('a flow whose expiry is not a number still expires (15 minutes at most)', () => {
    let now = 1_000_000
    const flows = new DeviceFlows(() => now)
    const f = flows.add('admin', {
      clientId: 'c',
      clientSecret: 's',
      deviceCode: 'd',
      userCode: 'u',
      verificationUrl: 'https://www.google.com/device',
      expiresAt: NaN,
      interval: 5,
    })
    expect(Number.isFinite(f.expiresAt)).toBe(true)
    now += 15 * 60_000 + 1
    expect(flows.get('admin', f.id)).toBeUndefined()
  })

  const answering = (status: number, json: unknown): Egress => ({
    request: () => Promise.reject(new Error('not used')),
    probe: () => Promise.reject(new Error('not used')),
    buffer: async () => ({ status, headers: {}, body: Buffer.from(JSON.stringify(json)) }),
    listed: () => false,
  })
  const hosts = {
    oauth: 'https://o.example.test',
    api: 'https://a.example.test',
    upload: 'https://u.example.test',
  }
  const signal = new AbortController().signal

  it('startDeviceFlow scrubs the provider’s error text and bounds odd timings', async () => {
    const e = await startDeviceFlow(
      answering(400, {
        error: 'bad refresh_token=1//secret-refresh-value-xyz Authorization: Bearer ya29.tok',
      }),
      hosts,
      'cid',
      signal,
    ).catch((x: Error) => x)
    expect(String((e as Error).message)).not.toContain('secret-refresh-value')
    expect(String((e as Error).message)).not.toContain('ya29.tok')
    const odd = await startDeviceFlow(
      answering(200, {
        device_code: 'dc',
        user_code: 'UC',
        verification_url: 'https://www.google.com/device',
        expires_in: 'soon',
        interval: -3,
      }),
      hosts,
      'cid',
      signal,
    )
    expect(Number.isFinite(odd.expiresIn) && odd.expiresIn > 0).toBe(true)
    expect(odd.interval).toBeGreaterThanOrEqual(1)
  })
})
