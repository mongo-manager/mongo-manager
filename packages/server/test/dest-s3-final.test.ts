// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { S3ConfigSchema } from '@mongo-manager/shared'
import { EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { createS3Adapter } from '../src/backup/destinations/s3'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { slow } from './support/slowness'

/* Phase 3d-3b final review: the S3 adapter's findings, against a scripted provider. */

interface Seen {
  method: string
  url: URL
  headers: Record<string, string>
  body: Buffer
  deadlineMs?: number
}
interface Reply {
  status: number
  headers?: Record<string, string | undefined>
  body?: string | Buffer | Readable
}
const handedOut: Readable[] = []
/** A body that never ends: only destroying it stops it. */
const endless = () =>
  new Readable({
    read() {
      this.push(Buffer.alloc(1024, 0x61))
    },
  })
function scripted(handler: (r: Seen, n: number) => Reply | Promise<Reply>) {
  const seen: Seen[] = []
  const egress: Egress = {
    async request(r: EgressRequest) {
      if (r.signal?.aborted) throw new EgressError('aborted', 'The request was stopped')
      const body =
        r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : await buffer(r.body)
      const s: Seen = {
        method: r.method,
        url: new URL(String(r.url)),
        headers: { ...r.headers },
        body,
        ...(r.deadlineMs !== undefined ? { deadlineMs: r.deadlineMs } : {}),
      }
      seen.push(s)
      const reply = await handler(s, seen.length)
      const stream =
        reply.body instanceof Readable
          ? reply.body
          : Readable.from(
              reply.body === undefined
                ? []
                : [typeof reply.body === 'string' ? Buffer.from(reply.body) : reply.body],
            )
      handedOut.push(stream)
      return { status: reply.status, headers: reply.headers ?? {}, body: stream }
    },
    buffer: () => Promise.reject(new Error('not used')),
    probe: () => Promise.reject(new Error('not used')),
    listed: () => false,
  }
  return { egress, seen }
}
afterEach(() => handedOut.splice(0).forEach((b) => b.destroy()))

const MiB = 1024 * 1024
const NOW = Date.UTC(2026, 9, 3, 12)
const signal = new AbortController().signal
function make(
  egress: Egress,
  over: Record<string, unknown> = {},
  opts: { retries?: number; partBytes?: number } = {},
) {
  return createS3Adapter({
    egress,
    config: S3ConfigSchema.parse({
      preset: 'aws',
      endpoint: 'https://s3.example.test',
      region: 'eu-west-1',
      bucket: 'mm-test',
      prefix: 'prod',
      pathStyle: true,
      ...over,
    }),
    secrets: { accessKeyId: 'AKIAFAKE00000001', secretAccessKey: 'fake-secret-key-0001' },
    partBytes: opts.partBytes ?? MiB,
    now: () => NOW,
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  })
}
const keyAt = (i: number, prefix = 'prod') =>
  remoteKeyFor(
    prefix,
    'mmbak',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000,
  )
const KEY = keyAt(1)
const xmlError = (code: string) =>
  `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-s3-final-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function file(size: number) {
  const body = Buffer.alloc(size, 7)
  const path = join(dir, `f-${Math.random()}`)
  writeFileSync(path, body)
  return {
    path,
    size,
    sha256: createHash('sha256').update(body).digest('hex'),
    md5: createHash('md5').update(body).digest('hex'),
  }
}
const io = (saved: Array<ResumeState | null> = []) => ({
  progress: () => undefined,
  saveResume: (s: ResumeState | null) => void saved.push(s && structuredClone(s)),
})

describe('S3 final review', () => {
  it('A1: answers that are not wanted are dropped, never drained', async () => {
    const { egress } = scripted(() => ({ status: 404, body: endless() }))
    const a = make(egress, {}, { retries: 0 })
    expect(await a.stat(KEY, signal)).toBeNull()
    await a.remove(KEY, signal)
    const ok = scripted(() => ({ status: 200, body: endless() }))
    await make(ok.egress).putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    await make(ok.egress).authCheck(signal)
    expect(handedOut.length).toBeGreaterThan(3)
    for (const b of handedOut) expect(b.destroyed).toBe(true)
  })

  it('A2: a ListParts that never advances, or lists foreign part numbers for ever, ends', async () => {
    const f = file(3 * MiB)
    for (const page of [
      // Truncated, the same marker each time.
      () =>
        `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker></ListPartsResult>`,
      // Truncated, no parts and no marker (Math.max of nothing).
      () => `<ListPartsResult><IsTruncated>true</IsTruncated></ListPartsResult>`,
      // Advancing for ever, with part numbers outside 1..count.
      (n: number) =>
        `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>${n * 1000}</NextPartNumberMarker>${Array.from(
          { length: 50 },
          (_, i) => `<Part><PartNumber>${n * 100_000 + i}</PartNumber><ETag>"e"</ETag><Size>1</Size></Part>`,
        ).join('')}</ListPartsResult>`,
    ]) {
      let lists = 0
      const { egress } = scripted((r) => {
        if (r.method === 'GET' && r.url.searchParams.has('uploadId')) {
          lists++
          if (lists > 50) throw new Error('ListParts never stopped')
          return { status: 200, body: page(lists) }
        }
        if (r.method === 'PUT') return { status: 200, headers: { etag: '"p"' } }
        if (r.method === 'POST') return { status: 200, body: '<CompleteMultipartUploadResult/>' }
        if (r.method === 'HEAD') return { status: 200, headers: { 'content-length': String(f.size) } }
        return { status: 200 }
      })
      const resume = { key: KEY, uploadId: 'u1', partSize: MiB, parts: [{ n: 1, etag: '"p"', size: MiB }] }
      await make(egress).put(KEY, f, resume, io(), signal)
      expect(lists).toBeLessThanOrEqual(11)
    }
  })

  it(
    'A5: a completion retried after the upload already completed is accepted when the object is whole',
    async () => {
      const f = file(2 * MiB + 5)
      let completes = 0
      const { egress } = scripted((r) => {
        if (r.method === 'POST' && r.url.searchParams.has('uploads'))
          return {
            status: 200,
            body: '<InitiateMultipartUploadResult><UploadId>u9</UploadId></InitiateMultipartUploadResult>',
          }
        if (r.method === 'PUT') return { status: 200, headers: { etag: '"p"' } }
        if (r.method === 'POST') {
          completes++
          // The first answer is lost on the way back; the retry finds the upload gone.
          if (completes === 1) throw new EgressError('network', 'The connection to the destination failed')
          return { status: 404, body: xmlError('NoSuchUpload') }
        }
        if (r.method === 'HEAD') return { status: 200, headers: { 'content-length': String(f.size) } }
        return { status: 500 }
      })
      const saved: Array<ResumeState | null> = []
      await make(egress).put(KEY, f, null, io(saved), signal)
      expect(completes).toBe(2)
      expect(saved.at(-1)).toBeNull()
    },
    slow(15_000),
  )

  it('A5: a NoSuchUpload completion with a missing or different object still fails', async () => {
    const f = file(2 * MiB + 5)
    const { egress } = scripted((r) => {
      if (r.method === 'POST' && r.url.searchParams.has('uploads'))
        return {
          status: 200,
          body: '<InitiateMultipartUploadResult><UploadId>u9</UploadId></InitiateMultipartUploadResult>',
        }
      if (r.method === 'PUT') return { status: 200, headers: { etag: '"p"' } }
      if (r.method === 'POST') return { status: 404, body: xmlError('NoSuchUpload') }
      if (r.method === 'HEAD') return { status: 200, headers: { 'content-length': '3' } }
      return { status: 500 }
    })
    await expect(make(egress).put(KEY, f, null, io(), signal)).rejects.toMatchObject({ reason: 'not_found' })
  })

  it('A7: manifests and the test probe are written without the archive storage class', async () => {
    const { egress, seen } = scripted(() => ({ status: 200, headers: { etag: '"x"' } }))
    const a = make(egress, { storageClass: 'DEEP_ARCHIVE', sse: { kind: 'AES256' } })
    await a.putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    expect(seen[0]!.headers['x-amz-storage-class']).toBeUndefined()
    expect(seen[0]!.headers['x-amz-server-side-encryption']).toBe('AES256')
    // The backup itself keeps the class it was configured with.
    const f = file(10)
    const big = scripted((r) =>
      r.method === 'HEAD' ? { status: 200, headers: { 'content-length': '10' } } : { status: 200 },
    )
    await make(big.egress, { storageClass: 'DEEP_ARCHIVE' }).put(KEY, f, null, io(), signal)
    expect(big.seen[0]!.headers['x-amz-storage-class']).toBe('DEEP_ARCHIVE')
  })

  const contents = (key: string) =>
    `<Contents><Key>${key}</Key><Size>5</Size><LastModified>2026-10-03T12:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>`
  /** A provider listing `total` keys in ascending order, `per` to a page. */
  function lister(total: number, per: number) {
    return scripted((r) => {
      const from = Number(r.url.searchParams.get('continuation-token') ?? 0)
      const keys = Array.from({ length: Math.min(per, total - from) }, (_, i) => keyAt(from + i))
      const more = from + per < total
      return {
        status: 200,
        body: `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + per}</NextContinuationToken>` : ''}${keys.map(contents).join('')}</ListBucketResult>`,
      }
    })
  }

  it('A9: lists newest first across the provider’s pages, with an offset cursor', async () => {
    const { egress } = lister(5, 2)
    const page = await make(egress).list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([keyAt(4), keyAt(3), keyAt(2), keyAt(1), keyAt(0)])
    expect(page.cursor).toBeNull()
  })

  it('A9: more than 10 000 objects: the newest 10 000, a page at a time', async () => {
    const { egress } = lister(10_500, 1000)
    const a = make(egress)
    const first = await a.list(null, signal)
    expect(first.items).toHaveLength(1000)
    expect(first.items[0]!.key).toBe(keyAt(10_499))
    expect(first.cursor).toBe('1000')
    let all = first.items.length
    let cursor = first.cursor
    let last = first.items.at(-1)!.key
    while (cursor) {
      const p = await a.list(cursor, signal)
      all += p.items.length
      last = p.items.at(-1)?.key ?? last
      cursor = p.cursor
    }
    expect(all).toBe(10_000)
    expect(last).toBe(keyAt(500))
  })

  it('A9: a provider repeating its continuation token does not keep us asking', async () => {
    const { egress, seen } = scripted(() => ({
      status: 200,
      body: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>${contents(keyAt(1))}</ListBucketResult>`,
    }))
    const page = await make(egress).list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([keyAt(1)])
    expect(seen.length).toBeLessThanOrEqual(2)
  })

  it('A12: a 206 that starts elsewhere than the offset is refused', async () => {
    const { egress } = scripted(() => ({
      status: 206,
      headers: { 'content-range': 'bytes 0-9/10' },
      body: '0123456789',
    }))
    await expect(make(egress).get(KEY, 4, signal)).resolves.toBeTruthy()
    const late = scripted(() => ({ status: 206, headers: { 'content-range': 'bytes 6-9/10' }, body: '6789' }))
    await expect(make(late.egress).get(KEY, 4, signal)).rejects.toThrow(/range/i)
    const right = scripted(() => ({
      status: 206,
      headers: { 'content-range': 'bytes 4-9/10' },
      body: '456789',
    }))
    expect((await buffer(await make(right.egress).get(KEY, 4, signal))).toString()).toBe('456789')
    const early = scripted(() => ({
      status: 206,
      headers: { 'content-range': 'bytes 2-9/10' },
      body: '23456789',
    }))
    expect((await buffer(await make(early.egress).get(KEY, 4, signal))).toString()).toBe('456789')
  })

  it('A15: a size that is missing, negative or not a number is refused, never NaN', async () => {
    for (const headers of [
      {},
      { 'content-length': '-1' },
      { 'content-length': 'abc' },
      { 'content-length': '1.5' },
    ]) {
      const { egress } = scripted(() => ({ status: 200, headers }))
      await expect(make(egress).stat(KEY, signal), JSON.stringify(headers)).rejects.toMatchObject({
        reason: 'provider',
      })
    }
    const { egress } = scripted(() => ({ status: 200, headers: { 'content-length': '42' } }))
    expect(await make(egress).stat(KEY, signal)).toMatchObject({ size: 42 })
  })

  it('A16: small answers carry an overall deadline; the object download does not', async () => {
    const { egress, seen } = scripted((r) =>
      r.method === 'HEAD'
        ? { status: 200, headers: { 'content-length': '1' } }
        : { status: 200, body: '<ListBucketResult/>' },
    )
    const a = make(egress)
    await a.stat(KEY, signal)
    await a.list(null, signal)
    await a.getSmall(`${KEY}.json`, 1024, signal)
    ;(await a.get(KEY, 0, signal)).destroy()
    expect(seen.map((s) => s.deadlineMs !== undefined)).toEqual([true, true, true, false])
  })

  it('A20: an endpoint with a path, a query or a fragment is refused', () => {
    const { egress } = scripted(() => ({ status: 200 }))
    for (const endpoint of [
      'https://s3.example.test/sub',
      'https://s3.example.test/?x=1',
      'https://s3.example.test/#f',
    ])
      expect(() => make(egress, { endpoint }), endpoint).toThrow(/endpoint/i)
    expect(() => make(egress, { endpoint: 'https://s3.example.test/' })).not.toThrow()
  })

  it('A22: a saved multipart upload is abandoned when the file now fits a single PUT', async () => {
    const f = file(100)
    const { egress, seen } = scripted((r) =>
      r.method === 'HEAD' ? { status: 200, headers: { 'content-length': '100' } } : { status: 204 },
    )
    const saved: Array<ResumeState | null> = []
    await make(egress).put(
      KEY,
      f,
      { key: KEY, uploadId: 'old-1', partSize: MiB, parts: [] },
      io(saved),
      signal,
    )
    const del = seen.find((s) => s.method === 'DELETE')
    expect(del?.url.searchParams.get('uploadId')).toBe('old-1')
    expect(saved.at(-1)).toBeNull()
  })
})
