// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { S3ConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createS3Adapter, partSizeFor } from '../src/backup/destinations/s3'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { startFakeS3, type FakeS3 } from './support/fake-s3'

let s3: FakeS3
let dir: string
const MiB = 1024 * 1024
const signal = new AbortController().signal
beforeAll(async () => {
  s3 = await startFakeS3({ pageSize: 2 })
  dir = mkdtempSync(join(tmpdir(), 'mm-s3-'))
})
afterAll(async () => {
  await s3?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  s3.objects.clear()
  s3.uploads.clear()
  s3.requests.length = 0
  s3.skew = false
})

const egress = createEgress({ networks: ['127.0.0.1/32'] })
function adapter(over: Record<string, unknown> = {}, secret?: string) {
  const config = S3ConfigSchema.parse({
    preset: 'minio',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'mm-test',
    prefix: 'prod',
    pathStyle: true,
    caPem: s3.caPem,
    ...over,
  })
  return createS3Adapter({
    egress,
    config,
    secrets: secret ? { ...s3.credentials, secretAccessKey: secret } : s3.credentials,
    partBytes: 16 * MiB,
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
const key = (n = 0) =>
  remoteKeyFor(
    'prod',
    'mmbak',
    `${String(n).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3),
  )
const io = (saved: Array<ResumeState | null> = [], sent: number[] = []) => ({
  progress: (n: number) => sent.push(n),
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})

describe('S3 destination (phase 3d-3b spec §2.3)', () => {
  it('sizes parts to stay under 10 000', () => {
    expect(partSizeFor(100 * MiB, 64 * MiB)).toBe(64 * MiB)
    expect(partSizeFor(5 * 1024 * 1024 * MiB, 16 * MiB)).toBe(525 * MiB)
  })

  it('puts a small object in one request, reads it back from an offset, stats, lists and removes it', async () => {
    const a = adapter()
    const { body, local } = file(1000)
    await a.put(key(), local, null, io(), signal)
    expect(s3.objects.get(key())!.body.equals(body)).toBe(true)
    expect(await a.stat(key(), signal)).toMatchObject({ size: 1000, archived: false })
    expect((await buffer(await a.get(key(), 10, signal))).equals(body.subarray(10))).toBe(true)
    await a.putSmall(`${key()}.json`, Buffer.from('{"v":1}'), signal)
    expect((await a.getSmall(`${key()}.json`, 1024, signal))!.toString()).toBe('{"v":1}')
    expect(await a.getSmall(`${key(9)}.json`, 1024, signal)).toBeNull()
    await a.remove(key(), signal)
    expect(await a.stat(key(), signal)).toBeNull()
  })

  it('uploads in parts and completes, sending storage class and encryption headers', async () => {
    const a = adapter({ storageClass: 'STANDARD_IA', sse: { kind: 'AES256' } })
    const { body, local } = file(40 * MiB)
    const saved: Array<ResumeState | null> = []
    const sent: number[] = []
    await a.put(key(), local, null, io(saved, sent), signal)
    expect(s3.objects.get(key())!.body.equals(body)).toBe(true)
    expect(s3.requests.filter((r) => r.startsWith('PUT') && r.includes('partNumber'))).toHaveLength(3)
    expect(sent.at(-1)).toBe(40 * MiB)
    expect(saved.at(-1)).toBeNull()
  })

  it('resumes from the parts already uploaded and resends a damaged one', async () => {
    const a = adapter()
    const { body, local } = file(48 * MiB)
    const ctl = new AbortController()
    const saved: Array<ResumeState | null> = []
    // Stop after the first two parts.
    const stopAfter = (s: ResumeState | null) => {
      saved.push(s && structuredClone(s))
      if (s && (s.parts as unknown[]).length === 2) ctl.abort()
    }
    await expect(
      a.put(key(), local, null, { progress: () => undefined, saveResume: stopAfter }, ctl.signal),
    ).rejects.toThrow()
    const resume = saved.filter(Boolean).at(-1)!
    const uploadId = resume.uploadId as string
    // Damage part 2 on the provider's side: its size no longer matches the record.
    s3.uploads.get(uploadId)!.set(2, Buffer.from('short'))
    s3.requests.length = 0
    await a.put(key(), local, resume, io(), signal)
    expect(s3.objects.get(key())!.body.equals(body)).toBe(true)
    const partPuts = s3.requests.filter((r) => r.startsWith('PUT') && r.includes('partNumber'))
    expect(partPuts.map((r) => /partNumber=(\d+)/.exec(r)![1])).toEqual(['2', '3'])
  })

  it('starts over when the provider forgot the upload', async () => {
    const a = adapter()
    const { body, local } = file(20 * MiB)
    await a.put(
      key(),
      local,
      { key: key(), uploadId: 'gone', partSize: 16 * MiB, parts: [{ n: 1, etag: '"x"', size: 16 * MiB }] },
      io(),
      signal,
    )
    expect(s3.objects.get(key())!.body.equals(body)).toBe(true)
  })

  it('retries 503 with Retry-After and gives up on a wrong secret', async () => {
    const a = adapter()
    s3.failNext(1, 503, '0')
    const { local } = file(10)
    await a.put(key(), local, null, io(), signal)
    // A HEAD answer has no body to name the cause: the listing (GET) does.
    await expect(adapter({}, 'wrong-secret-value').authCheck(signal)).rejects.toMatchObject({
      reason: 'auth',
    })
  })

  it('says the clock is wrong', async () => {
    s3.skew = true
    await expect(adapter().authCheck(signal)).rejects.toMatchObject({ reason: 'clock' })
  })

  it('lists the layout page by page and leaves foreign keys out', async () => {
    const a = adapter()
    for (let i = 0; i < 3; i++) s3.objects.set(key(i), { body: Buffer.from('x'), storageClass: 'STANDARD' })
    s3.objects.set('prod/mongo-manager/2026/10/notes.txt', {
      body: Buffer.from('x'),
      storageClass: 'STANDARD',
    })
    s3.objects.set(`${key(1)}.json`, { body: Buffer.from('{}'), storageClass: 'STANDARD' })
    const keys: string[] = []
    let cursor: string | null = null
    do {
      const page = await a.list(cursor, signal)
      keys.push(...page.items.map((i) => i.key))
      cursor = page.cursor
    } while (cursor)
    expect(keys.sort()).toEqual([key(0), key(1), key(2)])
  })

  it('marks archived objects and refuses to read them until thawed', async () => {
    const a = adapter()
    s3.objects.set(key(), { body: Buffer.from('cold'), storageClass: 'GLACIER' })
    expect(await a.stat(key(), signal)).toMatchObject({ archived: true })
    await expect(a.get(key(), 0, signal)).rejects.toMatchObject({ reason: 'archived' })
    s3.objects.get(key())!.restored = true
    expect(await a.stat(key(), signal)).toMatchObject({ archived: false })
    expect((await a.list(null, signal)).items[0]).toMatchObject({ archived: true })
  })

  it('abandons an unfinished upload', async () => {
    const a = adapter()
    s3.uploads.set('u1', new Map([[1, Buffer.from('x')]]))
    await a.abandon({ key: key(), uploadId: 'u1', partSize: 16 * MiB, parts: [] }, signal)
    expect(s3.uploads.has('u1')).toBe(false)
  })
})
