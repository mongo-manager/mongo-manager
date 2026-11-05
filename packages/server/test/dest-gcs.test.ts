// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { GcsConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createGcsAdapter } from '../src/backup/destinations/gcs'
import { GoogleTokens, STORAGE_SCOPE, parseServiceAccountKey } from '../src/backup/destinations/google-auth'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { startFakeGoogle, type FakeGoogle } from './support/fake-google'
import { installGcs } from './support/fake-gcs'
import { slow } from './support/slowness'

/** W4 item 5 (completion design §2 W4.5): Google Cloud Storage as a backup destination. */
let g: FakeGoogle
let gcs: ReturnType<typeof installGcs>
let dir: string
const signal = new AbortController().signal
const KiB = 1024
beforeAll(async () => {
  g = await startFakeGoogle()
  gcs = installGcs(g, { pageSize: 2 })
  dir = mkdtempSync(join(tmpdir(), 'mm-gcs-'))
})
afterAll(async () => {
  await g?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  gcs.objects.clear()
  gcs.sessions.clear()
  gcs.knobs.wrongMd5 = false
  gcs.knobs.sessionOrigin = null
  g.scopes.length = 0
})

const egress = createEgress({ networks: ['127.0.0.1/32'] })
function adapter(over: Record<string, unknown> = {}, partBytes = 256 * KiB) {
  const hosts = { ...g.hosts, storage: g.url }
  return createGcsAdapter({
    egress,
    hosts,
    tokens: new GoogleTokens({
      egress,
      hosts,
      source: {
        kind: 'serviceAccount',
        key: parseServiceAccountKey(JSON.stringify({ type: 'service_account', ...g.serviceKey })),
      },
      now: () => Date.now(),
      scope: STORAGE_SCOPE,
    }),
    config: GcsConfigSchema.parse({ bucket: 'mm-bucket', prefix: 'prod', ...over }),
    account: g.serviceKey.client_email,
    partBytes,
    now: () => Date.now(),
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
const key = () => remoteKeyFor('prod', 'mmbak', randomUUID(), Date.UTC(2026, 9, 16))
const io = (saved: Array<ResumeState | null> = [], sent: number[] = []) => ({
  progress: (n: number) => sent.push(n),
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})

describe('Google Cloud Storage destination (W4.5)', () => {
  it('signs in as the service account with the storage scope only', async () => {
    expect(await adapter().authCheck(signal)).toEqual({ account: g.serviceKey.client_email })
    expect(g.scopes).toEqual(['https://www.googleapis.com/auth/devstorage.read_write'])
  })

  it('uploads in 256 KiB parts in its storage class, verifies the MD5, and reads it back from an offset', async () => {
    const k = key()
    const f = file(700 * KiB)
    const sent: number[] = []
    const out = await adapter({ storageClass: 'COLDLINE' }).put(k, f.local, null, io([], sent), signal)
    expect(out.checksums).toEqual({ md5: f.local.md5 })
    expect(gcs.objects.get(k)!.body.equals(f.body)).toBe(true)
    expect(gcs.objects.get(k)!.storageClass).toBe('COLDLINE')
    expect(sent.at(-1)).toBe(700 * KiB)
    expect(await adapter().stat(k, signal)).toEqual({ size: 700 * KiB, archived: false, md5: f.local.md5 })
    const tail = await buffer(await adapter().get(k, 600 * KiB, signal))
    expect(tail.equals(f.body.subarray(600 * KiB))).toBe(true)
  })

  it('resumes an interrupted upload where Google says it stopped', async () => {
    const k = key()
    const f = file(600 * KiB)
    const saved: Array<ResumeState | null> = []
    const ctl = new AbortController()
    let parts = 0
    await expect(
      adapter().put(
        k,
        f.local,
        null,
        {
          progress: () => {
            if (++parts === 2) ctl.abort()
          },
          saveResume: (s) => saved.push(s && structuredClone(s)),
        },
        ctl.signal,
      ),
    ).rejects.toBeTruthy()
    const resume = saved.filter(Boolean).at(-1)!
    expect(String(resume.session)).toMatch(/upload_id=/)
    await adapter().put(k, f.local, resume, io(), signal)
    expect(gcs.objects.get(k)!.body.equals(f.body)).toBe(true)
  })

  // W4 review (minor): a part whose answer was lost may be held already: Google is asked first.
  it(
    'asks where the upload stands before sending a part again after a failure',
    async () => {
      const k = key()
      const f = file(3 * 256 * KiB)
      gcs.knobs.failAfterStore = 1
      gcs.knobs.strictRanges = true
      try {
        const out = await adapter().put(k, f.local, null, io(), signal)
        expect(out.checksums?.md5).toBe(f.local.md5)
        expect(gcs.objects.get(k)!.body.equals(f.body)).toBe(true)
      } finally {
        gcs.knobs.failAfterStore = 0
        gcs.knobs.strictRanges = false
      }
    },
    slow(30_000),
  )

  it('refuses an upload session on another host (a bearer capability), and a wrong checksum', async () => {
    gcs.knobs.sessionOrigin = 'https://evil.example'
    await expect(adapter().put(key(), file(10 * KiB).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'provider',
    })
    gcs.knobs.sessionOrigin = null
    gcs.knobs.wrongMd5 = true
    await expect(adapter().put(key(), file(10 * KiB).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'verify',
    })
  })

  it('never follows a saved session that leads elsewhere: it starts a new one', async () => {
    const k = key()
    const f = file(20 * KiB)
    await adapter().put(
      k,
      f.local,
      { key: k, session: 'https://evil.example/upload?upload_id=x' },
      io(),
      signal,
    )
    expect(gcs.objects.get(k)!.body.equals(f.body)).toBe(true)
  })

  it('lists only the layout’s objects, newest first, over several pages', async () => {
    const keys = [key(), key(), key()]
    for (const k of keys)
      gcs.objects.set(k, {
        body: Buffer.from('x'),
        storageClass: 'STANDARD',
        updated: '2026-10-16T00:00:00Z',
      })
    gcs.objects.set('prod/mongo-manager/../../etc/passwd', {
      body: Buffer.from('x'),
      storageClass: 'STANDARD',
      updated: '',
    })
    gcs.objects.set('prod/other.txt', { body: Buffer.from('x'), storageClass: 'STANDARD', updated: '' })
    const page = await adapter().list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([...keys].sort().reverse())
  })

  it('writes and reads small objects, removes, and cancels a session', async () => {
    const k = key()
    const a = adapter()
    await a.putSmall(k, Buffer.from('probe'), signal)
    expect((await a.getSmall(k, 64, signal))!.toString()).toBe('probe')
    await a.remove(k, signal)
    expect(await a.stat(k, signal)).toBeNull()
    expect(await a.getSmall(k, 64, signal)).toBeNull()
    await a.remove(k, signal)
    const saved: Array<ResumeState | null> = []
    const ctl = new AbortController()
    await a
      .put(
        key(),
        file(600 * KiB).local,
        null,
        { progress: () => ctl.abort(), saveResume: (s) => saved.push(s) },
        ctl.signal,
      )
      .catch(() => undefined)
    expect(gcs.sessions.size).toBe(1)
    await a.abandon(saved.filter(Boolean).at(-1)!, signal)
    expect(gcs.sessions.size).toBe(0)
  })

  it('says a bucket that does not exist, and refuses a bucket name Google would not take', async () => {
    await expect(adapter({ bucket: 'other-bucket' }).authCheck(signal)).rejects.toMatchObject({
      reason: 'bucket',
    })
    for (const bad of ['UPPER', 'a', '../x', 'a b'])
      expect(GcsConfigSchema.safeParse({ bucket: bad }).success, bad).toBe(false)
  })
})
