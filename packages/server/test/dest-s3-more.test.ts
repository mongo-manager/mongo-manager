import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { S3ConfigSchema } from '@mongo-manager/shared'
import { createEgress, EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { childrenOf, parseXml, textOf, XmlError } from '../src/net/xml'
import { createS3Adapter } from '../src/backup/destinations/s3'
import { canonicalQuery, canonicalUri, EMPTY_SHA256, signRequest } from '../src/backup/destinations/s3-sign'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { toDestinationError, type ResumeState } from '../src/backup/destinations/types'
import { startFakeS3, type FakeS3 } from './support/fake-s3'

/*
 * Phase 3d-3b spec §2.3: the S3 adapter against a scripted provider (every request seen, every
 * answer chosen, hostile ones included), plus SigV4 corner cases.
 */

interface Seen {
  method: string
  url: URL
  headers: Record<string, string>
  body: Buffer
}
interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer | Buffer[]
}
function scripted(handler: (r: Seen) => Reply | Promise<Reply>) {
  const seen: Seen[] = []
  const egress: Egress = {
    async request(r: EgressRequest) {
      if (r.signal?.aborted) throw new EgressError('aborted', 'The request was stopped')
      const body =
        r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : await buffer(r.body)
      const s: Seen = { method: r.method, url: new URL(String(r.url)), headers: { ...r.headers }, body }
      seen.push(s)
      const reply = await handler(s)
      const chunks =
        reply.body === undefined
          ? []
          : Array.isArray(reply.body)
            ? reply.body
            : [typeof reply.body === 'string' ? Buffer.from(reply.body) : reply.body]
      return { status: reply.status, headers: reply.headers ?? {}, body: Readable.from(chunks) }
    },
    buffer: () => Promise.reject(new Error('not used')),
    probe: () => Promise.reject(new Error('not used')),
    listed: () => false,
  }
  return { egress, seen }
}

const MiB = 1024 * 1024
const NOW = Date.UTC(2026, 9, 3, 12)
const signal = new AbortController().signal
const credentials = { accessKeyId: 'AKIAFAKE00000001', secretAccessKey: 'fake-secret-key-0001' }
function make(egress: Egress, over: Record<string, unknown> = {}, opts: { retries?: number } = {}) {
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
    secrets: credentials,
    partBytes: MiB,
    now: () => NOW,
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  })
}
const xmlError = (code: string, message = code) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`
const keyAt = (i: number, prefix = 'prod') =>
  remoteKeyFor(
    prefix,
    'mmbak',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3, 0, 0, i),
  )
const KEY = keyAt(1)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-s3-more-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function file(size: number) {
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i++) body[i] = (i * 31) % 251
  const path = join(dir, `f-${Math.random()}`)
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
const io = (saved: Array<ResumeState | null> = [], sent: number[] = []) => ({
  progress: (n: number) => sent.push(n),
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})
const caught = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}
const md5 = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`

describe('S3 refusals (phase 3d-3b spec §2.3)', () => {
  it('maps provider codes and statuses to reasons, keeping the code', async () => {
    const cases: Array<[Reply, Record<string, unknown>]> = [
      [
        { status: 404, body: xmlError('NoSuchBucket') },
        { reason: 'bucket', extra: { code: 'NoSuchBucket' } },
      ],
      [{ status: 403, body: xmlError('InvalidObjectState') }, { reason: 'archived' }],
      [{ status: 400, body: xmlError('AccessDenied') }, { reason: 'forbidden' }],
      [
        { status: 403, body: 'nope' },
        { reason: 'forbidden', extra: { status: 403 } },
      ],
      [{ status: 404 }, { reason: 'not_found' }],
      [{ status: 401 }, { reason: 'auth' }],
      [{ status: 400, body: xmlError('SignatureDoesNotMatch') }, { reason: 'auth' }],
      [{ status: 403, body: xmlError('InvalidAccessKeyId') }, { reason: 'auth' }],
      [{ status: 400, body: xmlError('RequestTimeTooSkewed') }, { reason: 'clock' }],
      [
        { status: 409, body: xmlError('BucketNotEmpty') },
        { reason: 'provider', extra: { code: 'BucketNotEmpty' } },
      ],
    ]
    for (const [reply, expected] of cases) {
      const { egress, seen } = scripted(() => reply)
      expect(await caught(make(egress).authCheck(signal))).toMatchObject(expected)
      // Refusals are answers: asked once.
      expect(seen).toHaveLength(1)
    }
  })

  it('scrubs what the provider says before it reaches a message', async () => {
    const said =
      'See https://s3.example.test/mm-test/x?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAFAKE00000001 password=hunter2'
    const { egress } = scripted(() => ({
      status: 400,
      body: xmlError('InvalidArgument', said.replace(/&/g, '&amp;')),
    }))
    const e = (await caught(make(egress).authCheck(signal))) as Error
    expect(e).toMatchObject({ reason: 'provider', extra: { code: 'InvalidArgument', status: 400 } })
    expect(e.message).toContain('InvalidArgument')
    expect(e.message).not.toContain('deadbeefcafe')
    expect(e.message).not.toContain('hunter2')
  })

  it('an oversized or non-XML error body leaves the status to speak', async () => {
    const huge = `<Error><Code>AccessDenied</Code><Message>${'x'.repeat(100_000)}</Message></Error>`
    const big = scripted(() => ({ status: 400, body: huge }))
    const e = (await caught(make(big.egress).authCheck(signal))) as Error
    expect(e).toMatchObject({ reason: 'provider', extra: { status: 400 } })
    expect(e.message).toContain('(400)')
    const html = scripted(() => ({ status: 500, body: '<html><body>Bad gateway' }))
    await expect(make(html.egress, {}, { retries: 0 }).authCheck(signal)).rejects.toMatchObject({
      reason: 'provider',
      extra: { status: 500 },
    })
  })

  it('retries a slow-down honouring Retry-After, and passes it on when no one retries', async () => {
    const answers: Reply[] = [
      { status: 503, headers: { 'retry-after': '0' }, body: xmlError('SlowDown') },
      { status: 200, body: '<ListBucketResult/>' },
    ]
    const retried = scripted(() => answers.shift()!)
    expect(await make(retried.egress).authCheck(signal)).toEqual({})
    expect(retried.seen).toHaveLength(2)
    const waiting = scripted(() => ({
      status: 503,
      headers: { 'retry-after': '7' },
      body: xmlError('SlowDown'),
    }))
    await expect(make(waiting.egress, {}, { retries: 0 }).authCheck(signal)).rejects.toMatchObject({
      reason: 'provider',
      extra: { status: 503, code: 'SlowDown', retryAfterMs: 7000 },
    })
    expect(waiting.seen).toHaveLength(1)
  })
})

describe('S3 requests', () => {
  it('addresses the bucket by name when not path-style, and signs the storage class and KMS headers', async () => {
    const { egress, seen } = scripted(() => ({ status: 200 }))
    const a = make(egress, {
      pathStyle: false,
      storageClass: 'STANDARD_IA',
      sse: { kind: 'aws:kms', keyId: 'arn:aws:kms:eu-west-1:111122223333:key/abc' },
    })
    expect(a.endpoint()!.href).toBe('https://mm-test.s3.example.test/')
    await a.putSmall(`${KEY}.json`, Buffer.from('{"v":1}'), signal)
    const put = seen[0]!
    expect(put.url.href).toBe(`https://mm-test.s3.example.test/${KEY}.json`)
    // Phase 3d-3b final review (A7): a small object is never written in the storage class.
    expect(put.headers['x-amz-storage-class']).toBeUndefined()
    expect(put.headers).toMatchObject({
      host: 'mm-test.s3.example.test',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'arn:aws:kms:eu-west-1:111122223333:key/abc',
      'x-amz-content-sha256': createHash('sha256').update('{"v":1}').digest('hex'),
      'content-length': '7',
    })
    expect(put.headers.authorization).toContain('/eu-west-1/s3/aws4_request')
    expect(put.headers.authorization).toContain(
      'x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id',
    )
    seen.length = 0
    await make(egress, { sse: { kind: 'aws:kms' } }).putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    expect(seen[0]!.headers['x-amz-server-side-encryption']).toBe('aws:kms')
    expect(seen[0]!.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined()
    expect(seen[0]!.headers['x-amz-storage-class']).toBeUndefined()
  })

  it('stat: an archive class is archived until a restore has finished', async () => {
    // W4.5: an archive class also says where its thaw stands.
    const cases: Array<[Record<string, string>, boolean, string | undefined]> = [
      [{ 'x-amz-storage-class': 'DEEP_ARCHIVE' }, true, 'none'],
      [{ 'x-amz-storage-class': 'GLACIER', 'x-amz-restore': 'ongoing-request="true"' }, true, 'thawing'],
      [
        { 'x-amz-storage-class': 'GLACIER', 'x-amz-restore': 'ongoing-request="false", expiry-date="x"' },
        false,
        'thawed',
      ],
      [{ 'x-amz-storage-class': 'GLACIER_IR' }, false, undefined],
      [{}, false, undefined],
    ]
    for (const [headers, archived, thaw] of cases) {
      const { egress } = scripted(() => ({ status: 200, headers: { ...headers, 'content-length': '12' } }))
      expect(await make(egress).stat(KEY, signal)).toEqual({ size: 12, archived, ...(thaw ? { thaw } : {}) })
    }
  })

  it('reading an archived object names the archive, not a generic refusal', async () => {
    const { egress } = scripted(() => ({
      status: 403,
      body: xmlError('InvalidObjectState', 'The operation is not valid for the object storage class'),
    }))
    await expect(make(egress).get(KEY, 0, signal)).rejects.toMatchObject({
      reason: 'archived',
      extra: { status: 403 },
    })
  })

  it('drops the bytes already held when Range is ignored, across chunk boundaries', async () => {
    const body = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
    const parts = [body.subarray(0, 100), body.subarray(100, 200), body.subarray(200)]
    const ignoring = scripted(() => ({ status: 200, body: parts }))
    expect((await buffer(await make(ignoring.egress).get(KEY, 150, signal))).equals(body.subarray(150))).toBe(
      true,
    )
    expect(ignoring.seen[0]!.headers.range).toBe('bytes=150-')
    const honouring = scripted(() => ({
      status: 206,
      headers: { 'content-range': 'bytes 250-299/300' },
      body: body.subarray(250),
    }))
    expect(
      (await buffer(await make(honouring.egress).get(KEY, 250, signal))).equals(body.subarray(250)),
    ).toBe(true)
    const whole = scripted(() => ({ status: 200, body: parts }))
    expect((await buffer(await make(whole.egress).get(KEY, 0, signal))).equals(body)).toBe(true)
    expect(whole.seen[0]!.headers.range).toBeUndefined()
  })

  it('getSmall refuses a body over its limit', async () => {
    const { egress } = scripted(() => ({ status: 200, body: [Buffer.alloc(600), Buffer.alloc(600)] }))
    const e = await caught(make(egress).getSmall(`${KEY}.json`, 1000, signal))
    expect(e).toBeInstanceOf(EgressError)
    expect(toDestinationError(e).reason).toBe('too_large')
  })

  it('remove and abandon accept a 404; abandon ignores a state without an upload', async () => {
    const { egress, seen } = scripted(() => ({ status: 404, body: xmlError('NoSuchUpload') }))
    const a = make(egress)
    await a.remove(KEY, signal)
    await a.abandon({ key: KEY, uploadId: 'u-1', partSize: MiB, parts: [] }, signal)
    await a.abandon({ key: KEY }, signal)
    await a.abandon({ uploadId: 'u-1' }, signal)
    expect(seen.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
      `DELETE /mm-test/${KEY}`,
      `DELETE /mm-test/${KEY}?uploadId=u-1`,
    ])
  })
})

describe('S3 listing', () => {
  const contents = (
    key: string,
    extra = '<Size>5</Size><LastModified>2026-10-03T12:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass>',
  ) => `<Contents><Key>${key}</Key>${extra}</Contents>`
  const listing = (items: string[], tail = '<IsTruncated>false</IsTruncated>') =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${tail}${items.join('')}</ListBucketResult>`

  it('keeps only our layout: no ../ keys, other prefixes, manifests or foreign names', async () => {
    const { egress, seen } = scripted(() => ({
      status: 200,
      body: listing(
        [
          contents(keyAt(1)),
          contents(`prod/mongo-manager/2026/10/../../../../etc/${keyAt(2).split('/').at(-1)}`),
          contents(`prod/mongo-manager/../${keyAt(3)}`),
          contents(keyAt(4, 'prodX')),
          contents(keyAt(5, 'prod/nested')),
          contents(`${keyAt(6)}.json`),
          contents('prod/mongo-manager/2026/10/notes.txt'),
          contents(keyAt(7), '<StorageClass>DEEP_ARCHIVE</StorageClass><LastModified>soon</LastModified>'),
          contents(
            keyAt(8).replace('.mmbak', '.archive.gz'),
            '<Size>9</Size><StorageClass>GLACIER_IR</StorageClass>',
          ),
          '<Contents><Size>1</Size></Contents>',
        ],
        // Truncated, yet no token: never a loop.
        '<IsTruncated>true</IsTruncated>',
      ),
    }))
    // Phase 3d-3b final review (A9): gathered and served newest first; the cursor is an offset.
    const page = await make(egress).list(null, signal)
    expect(page).toEqual({
      items: [
        { key: keyAt(8).replace('.mmbak', '.archive.gz'), size: 9, modifiedAt: null, archived: false },
        { key: keyAt(7), size: 0, modifiedAt: null, archived: true },
        { key: keyAt(1), size: 5, modifiedAt: NOW, archived: false },
      ],
      cursor: null,
    })
    expect(seen).toHaveLength(1)
    const q = seen[0]!.url.searchParams
    expect(Object.fromEntries(q)).toEqual({
      'list-type': '2',
      prefix: 'prod/mongo-manager/',
      'max-keys': '1000',
    })
  })

  it('passes the continuation token on, and lists under the bare layout without a prefix', async () => {
    const { egress, seen } = scripted((r) => ({
      status: 200,
      body: r.url.searchParams.has('continuation-token')
        ? listing([contents(keyAt(2, ''))])
        : listing(
            [contents(keyAt(1, ''))],
            '<IsTruncated>true</IsTruncated><NextContinuationToken>next/1+=</NextContinuationToken>',
          ),
    }))
    const page = await make(egress, { prefix: '' }).list(null, signal)
    expect(page.cursor).toBeNull()
    expect(page.items.map((i) => i.key)).toEqual([keyAt(2, ''), keyAt(1, '')])
    expect(seen[0]!.url.searchParams.get('prefix')).toBe('mongo-manager/')
    expect(seen[0]!.url.searchParams.has('continuation-token')).toBe(false)
    expect(seen[1]!.url.searchParams.get('continuation-token')).toBe('next/1+=')
  })

  it('refuses an oversized listing rather than answering part of it', async () => {
    const one = contents(keyAt(1))
    const items = Array.from({ length: Math.ceil((5 * MiB) / one.length) }, () => one)
    const { egress } = scripted(() => ({ status: 200, body: [Buffer.from(listing(items))] }))
    const e = await caught(make(egress).list(null, signal))
    expect(e).toBeInstanceOf(EgressError)
    expect(toDestinationError(e).reason).toBe('too_large')
  })

  it('refuses malformed XML and a DOCTYPE (no entity is ever expanded)', async () => {
    for (const body of [
      '<ListBucketResult><Contents><Key>x</Key>',
      `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY e SYSTEM "file:///etc/passwd">]><ListBucketResult><Contents><Key>&e;</Key></Contents></ListBucketResult>`,
      `<ListBucketResult><Contents><Key>&unknown;</Key></Contents></ListBucketResult>`,
    ]) {
      const { egress } = scripted(() => ({ status: 200, body }))
      const e = await caught(make(egress).list(null, signal))
      expect(e).toBeInstanceOf(XmlError)
      expect(toDestinationError(e).reason).toBe('provider')
    }
  })
})

describe('S3 multipart uploads (scripted provider)', () => {
  /**
   * A provider holding parts per upload id; `listParts` may rewrite what ListParts answers (a lying
   * provider), `partEtag` what a part PUT answers; `size` what HEAD says after completion.
   */
  function provider(
    opts: {
      initiate?: () => Reply
      listParts?: (parts: Map<number, Buffer>, marker: number) => Reply
      partEtag?: (n: number, body: Buffer) => string
      complete?: () => Reply
      size?: (real: number) => number
    } = {},
  ) {
    const uploads = new Map<string, Map<number, Buffer>>()
    let object: Buffer | null = null
    let next = 0
    const s = scripted((r) => {
      const q = r.url.searchParams
      const id = q.get('uploadId')
      if (r.method === 'POST' && q.has('uploads')) {
        if (opts.initiate) return opts.initiate()
        const created = `up-${++next}`
        uploads.set(created, new Map())
        return {
          status: 200,
          body: `<InitiateMultipartUploadResult><UploadId>${created}</UploadId></InitiateMultipartUploadResult>`,
        }
      }
      if (id !== null) {
        const parts = uploads.get(id)
        if (!parts) return { status: 404, body: xmlError('NoSuchUpload') }
        if (r.method === 'PUT') {
          const n = Number(q.get('partNumber'))
          parts.set(n, r.body)
          return { status: 200, headers: { etag: opts.partEtag ? opts.partEtag(n, r.body) : md5(r.body) } }
        }
        if (r.method === 'GET') {
          const marker = Number(q.get('part-number-marker'))
          if (opts.listParts) return opts.listParts(parts, marker)
          return {
            status: 200,
            body: `<ListPartsResult><IsTruncated>false</IsTruncated>${[...parts]
              .map(
                ([n, b]) =>
                  `<Part><PartNumber>${n}</PartNumber><ETag>${md5(b)}</ETag><Size>${b.length}</Size></Part>`,
              )
              .join('')}</ListPartsResult>`,
          }
        }
        if (r.method === 'POST') {
          if (opts.complete) return opts.complete()
          const doc = parseXml(r.body.toString())
          object = Buffer.concat(
            childrenOf(doc, 'Part').map((p) => parts.get(Number(textOf(p, 'PartNumber')))!),
          )
          uploads.delete(id)
          return {
            status: 200,
            body: '<CompleteMultipartUploadResult><ETag>"x-3"</ETag></CompleteMultipartUploadResult>',
          }
        }
        if (r.method === 'DELETE') {
          uploads.delete(id)
          return { status: 204 }
        }
      }
      if (r.method === 'HEAD')
        return object
          ? {
              status: 200,
              headers: { 'content-length': String(opts.size ? opts.size(object.length) : object.length) },
            }
          : { status: 404 }
      return { status: 400, body: xmlError('Unexpected') }
    })
    return { ...s, uploads, object: () => object }
  }
  const partPuts = (seen: Seen[]) =>
    seen
      .filter((r) => r.method === 'PUT' && r.url.searchParams.has('partNumber'))
      .map((r) => Number(r.url.searchParams.get('partNumber')))

  /** Sends until `stopAt` parts are up; answers the last resume state. */
  async function interrupted(
    p: ReturnType<typeof provider>,
    local: ReturnType<typeof file>['local'],
    stopAt: number,
  ) {
    const ctl = new AbortController()
    const saved: Array<ResumeState | null> = []
    await expect(
      make(p.egress).put(
        KEY,
        local,
        null,
        {
          progress: () => undefined,
          saveResume: (s) => {
            saved.push(s && structuredClone(s))
            if (s && (s.parts as unknown[]).length === stopAt) ctl.abort()
          },
        },
        ctl.signal,
      ),
    ).rejects.toMatchObject({ reason: 'aborted' })
    return saved.filter(Boolean).at(-1)! as ResumeState & {
      uploadId: string
      parts: Array<{ n: number; etag: string; size: number }>
    }
  }

  it('signs each part with its own hash and completes the parts in order', async () => {
    const p = provider()
    const { body, local } = file(2 * MiB + 500)
    const saved: Array<ResumeState | null> = []
    const sent: number[] = []
    await make(p.egress).put(KEY, local, null, io(saved, sent), signal)
    expect(p.object()!.equals(body)).toBe(true)
    const puts = p.seen.filter((r) => r.url.searchParams.has('partNumber'))
    expect(puts.map((r) => r.headers['content-length'])).toEqual([String(MiB), String(MiB), '500'])
    for (const r of puts)
      expect(r.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(r.body).digest('hex'))
    expect(sent).toEqual([0, MiB, 2 * MiB, 2 * MiB + 500])
    expect(saved.at(-1)).toBeNull()
  })

  it('resends a part whose ETag the provider reports differently, even at the right size', async () => {
    const p = provider()
    const { body, local } = file(3 * MiB)
    const resume = await interrupted(p, local, 2)
    // The provider now holds a different part 2 of the same size: its ETag changed.
    p.uploads.get(resume.uploadId)!.set(2, Buffer.alloc(MiB, 1))
    p.seen.length = 0
    await make(p.egress).put(KEY, local, resume, io(), signal)
    expect(partPuts(p.seen)).toEqual([2, 3])
    expect(p.object()!.equals(body)).toBe(true)
  })

  it('reads ListParts page by page, with and without a NextPartNumberMarker', async () => {
    const markers: number[] = []
    const p = provider({
      listParts: (parts, marker) => {
        markers.push(marker)
        const page = [...parts].filter(([n]) => n === marker + 1)
        const more = marker + 1 < 3
        const part = page
          .map(
            ([n, b]) =>
              `<Part><PartNumber>${n}</PartNumber><ETag>${md5(b)}</ETag><Size>${b.length}</Size></Part>`,
          )
          .join('')
        // The first page names its marker; the second leaves it out.
        const tail = more
          ? `<IsTruncated>true</IsTruncated>${marker === 0 ? '<NextPartNumberMarker>1</NextPartNumberMarker>' : ''}`
          : '<IsTruncated>false</IsTruncated>'
        return { status: 200, body: `<ListPartsResult>${tail}${part}</ListPartsResult>` }
      },
    })
    const { body, local } = file(3 * MiB)
    const resume = await interrupted(p, local, 3)
    p.seen.length = 0
    await make(p.egress).put(KEY, local, resume, io(), signal)
    expect(markers).toEqual([0, 1, 2])
    expect(partPuts(p.seen)).toEqual([])
    expect(p.object()!.equals(body)).toBe(true)
  })

  it('abandons the old upload when the saved state is for another key or part size', async () => {
    const p = provider()
    const { body, local } = file(2 * MiB)
    for (const stale of [
      { key: keyAt(9), uploadId: 'old-a', partSize: MiB, parts: [] },
      { key: KEY, uploadId: 'old-b', partSize: 8 * MiB, parts: [{ n: 1, etag: '"x"', size: 8 * MiB }] },
    ]) {
      p.seen.length = 0
      await make(p.egress).put(KEY, local, stale, io(), signal)
      expect(p.seen[0]!.method).toBe('DELETE')
      expect(p.seen[0]!.url.searchParams.get('uploadId')).toBe(stale.uploadId)
      expect(p.seen[0]!.url.pathname).toBe(`/mm-test/${stale.key}`)
      expect(partPuts(p.seen)).toEqual([1, 2])
      expect(p.object()!.equals(body)).toBe(true)
    }
  })

  it('refuses an initiation without an UploadId', async () => {
    const p = provider({ initiate: () => ({ status: 200, body: '<InitiateMultipartUploadResult/>' }) })
    await expect(make(p.egress).put(KEY, file(2 * MiB).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'provider',
    })
    expect(partPuts(p.seen)).toEqual([])
  })

  it('a completion answered 200 with an Error body fails and keeps the resume point', async () => {
    const p = provider({ complete: () => ({ status: 200, body: xmlError('InternalError', 'try again') }) })
    const saved: Array<ResumeState | null> = []
    const e = (await caught(make(p.egress).put(KEY, file(2 * MiB).local, null, io(saved), signal))) as Error
    expect(e).toMatchObject({ reason: 'provider' })
    expect(e.message).toContain('InternalError')
    expect(saved.at(-1)).toMatchObject({ key: KEY, partSize: MiB })
    expect(p.seen.some((r) => r.method === 'HEAD')).toBe(false)
  })

  it('escapes ETags in the completion so a hostile ETag cannot add or reorder parts', async () => {
    const hostile = '"a&b</ETag></Part><Part><PartNumber>9</PartNumber><ETag>z"'
    const p = provider({ partEtag: (n, b) => (n === 1 ? hostile : md5(b)) })
    const { body, local } = file(2 * MiB)
    await make(p.egress).put(KEY, local, null, io(), signal)
    const completion = p.seen.find((r) => r.method === 'POST' && !r.url.searchParams.has('uploads'))!
    const parts = childrenOf(parseXml(completion.body.toString()), 'Part')
    expect(parts.map((x) => textOf(x, 'PartNumber'))).toEqual(['1', '2'])
    expect(textOf(parts[0]!, 'ETag')).toBe(hostile)
    expect(p.object()!.equals(body)).toBe(true)
  })

  it('refuses an object whose size after the send differs from the backup', async () => {
    const multi = provider({ size: (n) => n - 1 })
    await expect(make(multi.egress).put(KEY, file(2 * MiB).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'verify',
    })
    const single = scripted((r) =>
      r.method === 'HEAD' ? { status: 200, headers: { 'content-length': '99' } } : { status: 200 },
    )
    await expect(make(single.egress).put(KEY, file(100).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'verify',
    })
    const gone = scripted((r) => (r.method === 'HEAD' ? { status: 404 } : { status: 200 }))
    await expect(make(gone.egress).put(KEY, file(100).local, null, io(), signal)).rejects.toMatchObject({
      reason: 'verify',
    })
  })
})

describe('S3 against the signing fake', () => {
  let s3: FakeS3
  beforeAll(async () => {
    s3 = await startFakeS3()
  })
  afterAll(() => s3?.close())
  const egress = createEgress({ networks: ['127.0.0.1/32'] })

  it('names a bucket that does not exist', async () => {
    const a = createS3Adapter({
      egress,
      config: S3ConfigSchema.parse({
        preset: 'minio',
        endpoint: s3.url,
        region: 'us-east-1',
        bucket: 'no-such-bucket',
        pathStyle: true,
        caPem: s3.caPem,
      }),
      secrets: s3.credentials,
      partBytes: 16 * MiB,
      now: () => Date.now(),
    })
    await expect(a.authCheck(signal)).rejects.toMatchObject({ reason: 'bucket' })
    expect(a.caPem()).toBe(s3.caPem)
    expect(a.readBack).toBe(false)
  })
})

describe('SigV4 corner cases (spec §2.3)', () => {
  it('sorts repeated query names by value, and keeps equal pairs', () => {
    expect(canonicalQuery(new URLSearchParams('z=1&a=2&a=1&a=1&b='))).toBe('a=1&a=1&a=2&b=&z=1')
    expect(canonicalQuery(new URLSearchParams('a=b&a=a'))).toBe('a=a&a=b')
    expect(canonicalQuery(new URLSearchParams(''))).toBe('')
  })

  it('encodes reserved characters RFC 3986 style, and an empty path is "/"', () => {
    expect(canonicalUri('')).toBe('/')
    expect(canonicalUri("/a!b'(c)*")).toBe('/a%21b%27%28c%29%2A')
    expect(canonicalQuery(new URLSearchParams("k=(v)!*'"))).toBe('k=%28v%29%21%2A%27')
  })

  it('folds header whitespace, lower-cases names, and scopes another service', () => {
    const now = new Date(Date.UTC(2026, 9, 3))
    const h = signRequest({
      method: 'GET',
      url: new URL('https://example.test/x'),
      headers: { 'X-Custom': '  a   b  ' },
      payloadHash: EMPTY_SHA256,
      region: 'eu-west-1',
      service: 'execute-api',
      now,
      credentials,
    })
    expect(h['x-custom']).toBe('a b')
    expect(h.authorization).toContain(
      'Credential=AKIAFAKE00000001/20261003/eu-west-1/execute-api/aws4_request',
    )
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-custom')
    const s3 = signRequest({
      method: 'GET',
      url: new URL('https://example.test/x'),
      headers: { 'X-Custom': 'a b' },
      payloadHash: EMPTY_SHA256,
      region: 'eu-west-1',
      now,
      credentials,
    })
    expect(s3.authorization).toContain('/s3/aws4_request')
    expect(s3.authorization).not.toBe(h.authorization)
  })
})
