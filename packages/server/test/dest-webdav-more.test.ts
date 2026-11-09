// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { WebdavConfigSchema } from '@mongo-manager/shared'
import { createEgress, EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { XmlError } from '../src/net/xml'
import { createWebdavAdapter } from '../src/backup/destinations/webdav'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { toDestinationError, type ResumeState } from '../src/backup/destinations/types'
import { startFakeWebdav } from './support/fake-webdav'

/*
 * Phase 3d-3b spec §2.5: the WebDAV adapter against a scripted server (every request seen, every
 * answer chosen, hostile ones included) and, for chunked resumes, against the shared fake.
 */

interface Seen {
  method: string
  url: URL
  headers: Record<string, string>
  body: Buffer
  caPem?: string
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
      const s: Seen = {
        method: r.method,
        url: new URL(String(r.url)),
        headers: { ...r.headers },
        body,
        ...(r.caPem ? { caPem: r.caPem } : {}),
      }
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

const SITE = 'https://dav.example.test'
const NOW = Date.UTC(2026, 9, 3, 12)
const signal = new AbortController().signal
let clock = NOW
function make(
  egress: Egress,
  over: Record<string, unknown> = {},
  opts: { retries?: number; partBytes?: number } = {},
) {
  return createWebdavAdapter({
    egress,
    config: WebdavConfigSchema.parse({
      preset: 'generic',
      url: `${SITE}/dav/`,
      folder: 'Backups/Mongo',
      username: 'ops',
      ...over,
    }),
    secrets: { password: 'pw' },
    partBytes: opts.partBytes ?? 1000,
    // Distinct per call: a chunk folder's name is derived from the key and the time.
    now: () => clock++,
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  })
}

const multistatus = (entries: string[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`
const fileEntry = (href: string, size: number | null, modified = 'Sat, 03 Oct 2026 12:00:00 GMT') =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/>${size === null ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`}<d:getlastmodified>${modified}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
const dirEntry = (href: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`

const keyAt = (i: number, prefix = '') =>
  remoteKeyFor(
    prefix,
    'gzip',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3, 0, 0, i),
  )
const KEY = keyAt(1)
const LAYOUT = '/dav/Backups/Mongo/mongo-manager'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-dav-more-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function local(size: number) {
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i++) body[i] = (i * 13) % 251
  const path = join(dir, `f-${Math.random()}`)
  writeFileSync(path, body)
  return {
    body,
    file: {
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

describe('WebDAV refusals (phase 3d-3b spec §2.5)', () => {
  it('maps each refusal to its reason with the status, and does not retry a refusal', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [423, 'provider'],
      [405, 'provider'],
    ]
    for (const [status, reason] of cases) {
      const { egress, seen } = scripted((r) => (r.method === 'PUT' ? { status } : { status: 201 }))
      const e = await caught(make(egress).putSmall(`${KEY}.json`, Buffer.from('{}'), signal))
      expect(e).toMatchObject({ reason, extra: { status } })
      // A refusal is an answer: asked once.
      expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(1)
    }
  })

  it('a full destination (507) is the quota reason and is not sent again', async () => {
    // Retry-After 0 keeps the test fast should the adapter retry; a full disk does not empty itself.
    const { egress, seen } = scripted((r) =>
      r.method === 'PUT' ? { status: 507, headers: { 'retry-after': '0' } } : { status: 201 },
    )
    const e = await caught(make(egress).putSmall(`${KEY}.json`, Buffer.from('{}'), signal))
    expect(e).toMatchObject({ reason: 'quota', extra: { status: 507 } })
    expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(1)
  })

  it('a full destination stops a chunked send with the quota reason and keeps the resume point', async () => {
    const { file } = local(2500)
    const { egress, seen } = scripted((r) => {
      if (r.method === 'PUT' && r.url.pathname.endsWith('/00002'))
        return { status: 507, headers: { 'retry-after': '0' } }
      return { status: 201 }
    })
    const saved: Array<ResumeState | null> = []
    const e = await caught(
      make(egress, { preset: 'nextcloud', url: SITE }).put(KEY, file, null, io(saved), signal),
    )
    expect(e).toMatchObject({ reason: 'quota', extra: { status: 507 } })
    expect(saved.at(-1)).toMatchObject({ key: KEY, chunkSize: 1000 })
    expect(String(saved.at(-1)!.dir)).toMatch(
      /^https:\/\/dav\.example\.test\/remote\.php\/dav\/uploads\/ops\/mm-[0-9a-f]{24}$/,
    )
    // Nothing after the refused chunk, and no assembly.
    expect(seen.some((r) => r.url.pathname.endsWith('/00003') || r.method === 'MOVE')).toBe(false)
  })

  it('retries 429 and 5xx honouring Retry-After (seconds and dates), sending the whole file again', async () => {
    const { body, file } = local(3000)
    const answers: Reply[] = [
      { status: 429, headers: { 'retry-after': '0' } },
      // A date already past: wait no longer.
      { status: 503, headers: { 'retry-after': 'Thu, 01 Oct 2026 00:00:00 GMT' } },
      { status: 201 },
    ]
    const { egress, seen } = scripted((r) => (r.method === 'PUT' ? answers.shift()! : { status: 201 }))
    const sent: number[] = []
    await make(egress).put(KEY, file, null, io([], sent), signal)
    const puts = seen.filter((r) => r.method === 'PUT')
    expect(puts).toHaveLength(3)
    for (const p of puts) {
      expect(p.body.equals(body)).toBe(true)
      expect(p.headers['content-length']).toBe('3000')
      expect(p.url.pathname).toBe(`/dav/Backups/Mongo/${KEY}`)
    }
    expect(sent.at(-1)).toBe(3000)
  })

  it('gives up after three retries, and retries nothing when someone waits', async () => {
    const { egress, seen } = scripted(() => ({ status: 502, headers: { 'retry-after': '0' } }))
    await expect(make(egress).stat(KEY, signal)).rejects.toMatchObject({
      reason: 'provider',
      extra: { status: 502, retryAfterMs: 0 },
    })
    expect(seen).toHaveLength(4)
    seen.length = 0
    await expect(make(egress, {}, { retries: 0 }).stat(KEY, signal)).rejects.toMatchObject({
      reason: 'provider',
    })
    expect(seen).toHaveLength(1)
  })
})

describe('WebDAV folders and properties', () => {
  it('creates a missing layout root one level at a time, accepting levels that exist', async () => {
    const { egress, seen } = scripted((r) => {
      if (r.method === 'PROPFIND') return { status: 404 }
      return { status: r.url.pathname === '/dav/Backups/' ? 405 : 201 }
    })
    expect(await make(egress).authCheck(signal)).toEqual({})
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'PROPFIND /dav/Backups/Mongo/',
      'MKCOL /dav/Backups/',
      'MKCOL /dav/Backups/Mongo/',
      `MKCOL ${LAYOUT}/`,
    ])
    const find = seen[0]!
    expect(find.headers.depth).toBe('0')
    expect(find.headers.authorization).toBe(`Basic ${Buffer.from('ops:pw').toString('base64')}`)
    expect(find.body.toString()).toContain('<d:getcontentlength/>')
    // No certificate configured: none passed on.
    expect(find.caPem).toBeUndefined()
  })

  it('creates nothing when the folder is there, and a missing parent is a conflict', async () => {
    const there = scripted(() => ({ status: 207, body: multistatus([dirEntry('/dav/Backups/Mongo/')]) }))
    await make(there.egress).authCheck(signal)
    expect(there.seen.map((r) => r.method)).toEqual(['PROPFIND'])
    const orphan = scripted((r) => (r.method === 'MKCOL' ? { status: 409 } : { status: 201 }))
    await expect(
      make(orphan.egress).putSmall(`${KEY}.json`, Buffer.from('{}'), signal),
    ).rejects.toMatchObject({ reason: 'conflict' })
    expect(orphan.seen.filter((r) => r.method === 'PUT')).toHaveLength(0)
  })

  it('stat reads a size from an answer without propstat; folders, missing sizes and 404s are not objects', async () => {
    const answers: Record<string, Reply> = {
      a: {
        status: 207,
        body: multistatus([
          `<d:response><d:href>/x</d:href><d:prop><d:getcontentlength>42</d:getcontentlength></d:prop></d:response>`,
        ]),
      },
      b: { status: 207, body: multistatus([dirEntry(`/dav/Backups/Mongo/${KEY}/`)]) },
      c: { status: 207, body: multistatus([fileEntry(`/dav/Backups/Mongo/${KEY}`, null)]) },
      d: { status: 404 },
      e: { status: 207, body: multistatus([]) },
    }
    for (const [which, expected] of [
      ['a', { size: 42, archived: false }],
      ['b', null],
      ['c', null],
      ['d', null],
      ['e', null],
    ] as const) {
      const { egress } = scripted(() => answers[which]!)
      expect(await make(egress).stat(KEY, signal)).toEqual(expected)
    }
  })

  it('refuses an oversized PROPFIND answer instead of reading it all', async () => {
    const MiB = 1024 * 1024
    const big = Array.from({ length: 5 }, () => Buffer.alloc(MiB, 0x20))
    const { egress } = scripted(() => ({ status: 207, body: big }))
    const e = await caught(make(egress).stat(KEY, signal))
    expect(e).toBeInstanceOf(EgressError)
    expect(toDestinationError(e).reason).toBe('too_large')
  })

  it('refuses malformed XML and a DOCTYPE (no entity is ever expanded)', async () => {
    for (const body of [
      '<d:multistatus xmlns:d="DAV:"><d:response>',
      `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"><d:response><d:href>&x;</d:href></d:response></d:multistatus>`,
      'not xml at all',
    ]) {
      const { egress } = scripted(() => ({ status: 207, body }))
      const e = await caught(make(egress).list(null, signal))
      expect(e).toBeInstanceOf(XmlError)
      // What reaches the user is a provider failure, not a crash.
      expect(toDestinationError(e).reason).toBe('provider')
    }
  })
})

describe('WebDAV listing', () => {
  /** A layout tree: folder path (relative to the layout root, '' for the root) → its entries. */
  function tree(entries: Record<string, string[]>) {
    return scripted((r) => {
      if (r.method !== 'PROPFIND') return { status: 405 }
      const path = decodeURIComponent(r.url.pathname)
      const rel = path.startsWith(`${LAYOUT}/`) ? path.slice(LAYOUT.length + 1).replace(/\/$/, '') : null
      const found = rel === null ? undefined : entries[rel]
      if (!found) return { status: 404 }
      return { status: 207, body: multistatus([dirEntry(`${LAYOUT}/${rel ? `${rel}/` : ''}`), ...found]) }
    })
  }

  it('walks year and month folders only, keeping our objects and nothing foreign', async () => {
    const { egress, seen } = tree({
      '': [
        dirEntry(`${LAYOUT}/2026/`),
        fileEntry(`${LAYOUT}/stray.archive`, 5),
        // Outside the configured folder altogether.
        fileEntry('/elsewhere/mongo-manager/2026/10/x', 5),
        fileEntry(`/dav/Backups/${keyAt(9)}`, 5),
      ],
      '2026': [dirEntry(`${LAYOUT}/2026/10/`)],
      '2026/10': [
        fileEntry(`${LAYOUT.slice(0, -'mongo-manager'.length)}${keyAt(1)}`, 100),
        // A date the server cannot be trusted on, and no size at all.
        fileEntry(`/dav/Backups/Mongo/${keyAt(2)}`, null, 'yesterday-ish'),
        fileEntry(`/dav/Backups/Mongo/${keyAt(3)}.json`, 2),
        fileEntry(`${LAYOUT}/2026/10/notes.txt`, 2),
        // Encoded the way servers do: a space as %20 is decoded before the key is judged.
        fileEntry(`${LAYOUT}/2026/10/mm-20261003-000004-0000000%34.archive.gz`, 7),
        // A folder at month depth is never walked.
        dirEntry(`${LAYOUT}/2026/10/deep/`),
      ],
      '2026/10/deep': [fileEntry(`${LAYOUT}/2026/10/deep/${keyAt(5).split('/').at(-1)}`, 1)],
    })
    const page = await make(egress).list(null, signal)
    expect(page.cursor).toBeNull()
    expect(page.items).toEqual([
      { key: keyAt(4), size: 7, modifiedAt: NOW, archived: false },
      { key: keyAt(2), size: 0, modifiedAt: null, archived: false },
      { key: keyAt(1), size: 100, modifiedAt: NOW, archived: false },
    ])
    expect(seen.map((r) => decodeURIComponent(r.url.pathname))).toEqual([
      `${LAYOUT}/`,
      `${LAYOUT}/2026/`,
      `${LAYOUT}/2026/10/`,
    ])
    expect(seen.every((r) => r.headers.depth === '1')).toBe(true)
  })

  it('never follows a folder name that climbs out of the layout', async () => {
    const { egress, seen } = tree({
      '': [
        // An encoded slash survives URL parsing and is decoded into "../" segments.
        dirEntry(`${LAYOUT}/..%2F..%2F..%2Fsecret/`),
        dirEntry(`${LAYOUT}/2026/`),
      ],
      '2026': [],
    })
    await make(egress).list(null, signal)
    for (const r of seen) expect(r.url.pathname.startsWith(`${LAYOUT}/`)).toBe(true)
  })

  it('a listing that repeats a folder or an object lists each object once', async () => {
    const { egress, seen } = tree({
      '': [dirEntry(`${LAYOUT}/2026/`), dirEntry(`${LAYOUT}/2026/`)],
      '2026': [dirEntry(`${LAYOUT}/2026/10/`)],
      '2026/10': [
        fileEntry(`${LAYOUT}/2026/10/${keyAt(1).split('/').at(-1)}`, 1),
        fileEntry(`${LAYOUT}/2026/10/${keyAt(1).split('/').at(-1)}`, 1),
      ],
    })
    const page = await make(egress).list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([keyAt(1)])
    expect(seen.filter((r) => r.url.pathname === `${LAYOUT}/2026/10/`)).toHaveLength(1)
  })

  it('pages a long listing 1000 at a time, newest first', async () => {
    const names = Array.from({ length: 2500 }, (_, i) => keyAt(i))
    const { egress } = tree({
      '': [dirEntry(`${LAYOUT}/2026/`)],
      '2026': [dirEntry(`${LAYOUT}/2026/10/`)],
      '2026/10': names.map((k) => fileEntry(`/dav/Backups/Mongo/${k}`, 1)),
    })
    const a = make(egress)
    const pages: string[][] = []
    let cursor: string | null = null
    do {
      const page = await a.list(cursor, signal)
      pages.push(page.items.map((i) => i.key))
      cursor = page.cursor
    } while (cursor)
    expect(pages.map((p) => p.length)).toEqual([1000, 1000, 500])
    const all = pages.flat()
    expect(new Set(all).size).toBe(2500)
    expect(all).toEqual([...names].sort().reverse())
  })

  it('stops at 10 000 objects however many the server names', async () => {
    const names = Array.from({ length: 10_050 }, (_, i) => keyAt(i))
    const { egress } = tree({
      '': [dirEntry(`${LAYOUT}/2026/`)],
      '2026': [dirEntry(`${LAYOUT}/2026/10/`)],
      '2026/10': names.map(
        (k) =>
          `<d:response><d:href>/dav/Backups/Mongo/${k}</d:href><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop></d:response>`,
      ),
    })
    const last = await make(egress).list('9000', signal)
    expect(last.items).toHaveLength(1000)
    expect(last.cursor).toBeNull()
  })

  it('a missing layout lists nothing', async () => {
    const { egress } = scripted(() => ({ status: 404 }))
    expect(await make(egress).list(null, signal)).toEqual({ items: [], cursor: null })
  })
})

describe('WebDAV reads and deletes', () => {
  const body = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
  const parts = [body.subarray(0, 100), body.subarray(100, 200), body.subarray(200)]

  it('drops the bytes already held when Range is ignored, across chunk boundaries', async () => {
    const ignoring = scripted(() => ({ status: 200, body: parts }))
    const got = await buffer(await make(ignoring.egress).get(KEY, 150, signal))
    expect(got.equals(body.subarray(150))).toBe(true)
    expect(ignoring.seen[0]!.headers.range).toBe('bytes=150-')
    const honouring = scripted((r) => ({
      status: 206,
      body: body.subarray(Number(/\d+/.exec(r.headers.range!)![0])),
    }))
    expect(
      (await buffer(await make(honouring.egress).get(KEY, 250, signal))).equals(body.subarray(250)),
    ).toBe(true)
    const whole = scripted(() => ({ status: 200, body: parts }))
    expect((await buffer(await make(whole.egress).get(KEY, 0, signal))).equals(body)).toBe(true)
    expect(whole.seen[0]!.headers.range).toBeUndefined()
  })

  it('getSmall answers null for a missing object and refuses one over its limit', async () => {
    const missing = scripted(() => ({ status: 404 }))
    expect(await make(missing.egress).getSmall(`${KEY}.json`, 1024, signal)).toBeNull()
    const big = scripted(() => ({ status: 200, body: parts }))
    await expect(make(big.egress).getSmall(`${KEY}.json`, 250, signal)).rejects.toMatchObject({
      reason: 'too_large',
    })
    const fits = scripted(() => ({ status: 200, body: '{"v":1}' }))
    expect((await make(fits.egress).getSmall(`${KEY}.json`, 1024, signal))!.toString()).toBe('{"v":1}')
  })

  it('refuses keys outside the layout before asking the server', async () => {
    const { egress, seen } = scripted(() => ({ status: 200 }))
    const a = make(egress)
    await expect(a.get('../../etc/passwd', 0, signal)).rejects.toMatchObject({ reason: 'path' })
    await expect(a.remove('mongo-manager/%2e%2e/x', signal)).rejects.toMatchObject({ reason: 'path' })
    expect(seen).toHaveLength(0)
  })

  it('remove and abandon accept a 404', async () => {
    const { egress, seen } = scripted(() => ({ status: 404 }))
    const a = make(egress, { preset: 'nextcloud', url: SITE })
    await a.remove(KEY, signal)
    await a.abandon(
      { key: KEY, dir: `${SITE}/remote.php/dav/uploads/ops/mm-0123456789abcdef01234567`, chunkSize: 1000 },
      signal,
    )
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      `DELETE /remote.php/dav/files/ops/Backups/Mongo/${KEY}`,
      'DELETE /remote.php/dav/uploads/ops/mm-0123456789abcdef01234567/',
    ])
  })

  it('abandon deletes only our own chunk folders', async () => {
    const { egress, seen } = scripted(() => ({ status: 204 }))
    const a = make(egress, { preset: 'nextcloud', url: SITE })
    for (const dir of [
      `${SITE}/remote.php/dav/files/ops/Backups`,
      `${SITE}/remote.php/dav/uploads/ops/other`,
      'https://evil.example/remote.php/dav/uploads/ops/mm-abc',
      42,
      undefined,
      // Starts like ours, then climbs out to the user's files.
      `${SITE}/remote.php/dav/uploads/ops/mm-x/../../../files/ops`,
    ])
      await a.abandon({ key: KEY, dir, chunkSize: 1000 }, signal)
    for (const r of seen) expect(r.url.pathname.startsWith('/remote.php/dav/uploads/ops/mm-')).toBe(true)
  })
})

describe('Nextcloud chunked uploads (scripted)', () => {
  /** A Nextcloud that assembles chunks on MOVE; `assembled` lets a test make it lie about the result. */
  function cloud(opts: { assembled?: (real: number) => number } = {}) {
    const chunks = new Map<string, Buffer>()
    let size = -1
    return scripted((r) => {
      const path = decodeURIComponent(r.url.pathname)
      if (r.method === 'MKCOL') return { status: 201 }
      if (r.method === 'PUT') {
        chunks.set(path, r.body)
        return { status: 201 }
      }
      if (r.method === 'MOVE') {
        const dir = path.slice(0, -'/.file'.length)
        size = [...chunks].filter(([k]) => k.startsWith(`${dir}/`)).reduce((n, [, b]) => n + b.length, 0)
        return { status: 201 }
      }
      if (r.method === 'PROPFIND')
        return size < 0
          ? { status: 404 }
          : {
              status: 207,
              body: multistatus([fileEntry(path, opts.assembled ? opts.assembled(size) : size)]),
            }
      return { status: 405 }
    })
  }

  it('sends each chunk with its destination and total, then assembles without overwriting', async () => {
    const { body, file } = local(2500)
    const { egress, seen } = cloud()
    const saved: Array<ResumeState | null> = []
    const sent: number[] = []
    const a = make(egress, { preset: 'nextcloud', url: SITE, username: 'ops@corp' })
    expect(a.endpoint()!.href).toBe(`${SITE}/remote.php/dav/files/ops%40corp/`)
    await a.put(KEY, file, null, io(saved, sent), signal)
    const target = `${SITE}/remote.php/dav/files/ops%40corp/Backups/Mongo/${KEY}`
    const mk = seen.find((r) => r.method === 'MKCOL' && r.url.pathname.includes('/uploads/'))!
    expect(mk.url.pathname).toMatch(/^\/remote\.php\/dav\/uploads\/ops%40corp\/mm-[0-9a-f]{24}\/$/)
    expect(mk.headers.destination).toBe(target)
    const puts = seen.filter((r) => r.method === 'PUT')
    expect(puts.map((r) => r.url.pathname.split('/').at(-1))).toEqual(['00001', '00002', '00003'])
    expect(puts.map((r) => r.headers['content-length'])).toEqual(['1000', '1000', '500'])
    expect(Buffer.concat(puts.map((r) => r.body)).equals(body)).toBe(true)
    for (const p of puts) {
      expect(p.headers.destination).toBe(target)
      expect(p.headers['oc-total-length']).toBe('2500')
    }
    const move = seen.find((r) => r.method === 'MOVE')!
    expect(move.url.pathname.endsWith('/.file')).toBe(true)
    expect(move.headers).toMatchObject({ destination: target, overwrite: 'F', 'oc-total-length': '2500' })
    // The state is saved before the first chunk, after each, and cleared at the end.
    expect(saved).toHaveLength(5)
    expect(saved.at(-1)).toBeNull()
    expect(sent.at(-1)).toBe(2500)
    expect([...sent].sort((x, y) => x - y)).toEqual(sent)
  })

  it('refuses an assembled object whose size differs from the backup', async () => {
    const { file } = local(2500)
    const { egress } = cloud({ assembled: (n) => n - 1 })
    await expect(
      make(egress, { preset: 'nextcloud', url: SITE }).put(KEY, file, null, io(), signal),
    ).rejects.toMatchObject({ reason: 'verify' })
  })
})

describe('Nextcloud chunked resumes (fake server)', () => {
  type Fake = Awaited<ReturnType<typeof startFakeWebdav>>
  let fake: Fake
  beforeAll(async () => {
    fake = await startFakeWebdav({ user: 'ops', password: 'app-password', nextcloud: true })
  })
  afterAll(() => fake?.close())
  const egress = createEgress({ networks: ['127.0.0.1/32'] })
  const adapter = () =>
    createWebdavAdapter({
      egress,
      config: WebdavConfigSchema.parse({
        preset: 'nextcloud',
        url: fake.root,
        folder: 'Backups/Mongo',
        username: 'ops',
        caPem: fake.caPem,
      }),
      secrets: { password: 'app-password' },
      partBytes: 1000,
      now: () => clock++,
    })
  const chunkPuts = () => fake.requests.filter((r) => r.startsWith('PUT') && r.includes('/uploads/'))

  /** Sends until `stopAt` chunks are up, then stops; answers the last resume state. */
  async function interrupted(key: string, file: ReturnType<typeof local>['file'], stopAt: number) {
    const ctl = new AbortController()
    const saved: Array<ResumeState | null> = []
    let chunks = 0
    await expect(
      adapter().put(
        key,
        file,
        null,
        {
          progress: () => undefined,
          saveResume: (s) => {
            saved.push(s && structuredClone(s))
            if (s && chunks++ === stopAt) ctl.abort()
          },
        },
        ctl.signal,
      ),
    ).rejects.toMatchObject({ reason: 'aborted' })
    return saved.filter(Boolean).at(-1)!
  }

  it('resends a chunk the server holds at the wrong size and keeps the ones that match', async () => {
    const key = keyAt(21)
    const { body, file } = local(3500)
    const resume = await interrupted(key, file, 3)
    const chunkDir = `${new URL(String(resume.dir)).pathname.slice(1)}`
    expect([...fake.files.keys()].filter((k) => k.startsWith(`${chunkDir}/`)).sort()).toEqual([
      `${chunkDir}/00001`,
      `${chunkDir}/00002`,
      `${chunkDir}/00003`,
    ])
    // The server lies: chunk 2 is short.
    fake.files.set(`${chunkDir}/00002`, Buffer.from('short'))
    fake.requests.length = 0
    const sent: number[] = []
    await adapter().put(key, file, resume, io([], sent), signal)
    expect(fake.files.get(`${fake.filesRoot}Backups/Mongo/${key}`)!.equals(body)).toBe(true)
    expect(chunkPuts().map((r) => r.split('/').at(-1))).toEqual(['00002', '00004'])
    expect(sent.at(-1)).toBe(3500)
  })

  it('starts a fresh chunk folder for another key, another chunk size, or a folder the server forgot', async () => {
    const key = keyAt(22)
    const { body, file } = local(2500)
    const resume = await interrupted(key, file, 1)
    const forgot = { ...resume, dir: `${fake.root}remote.php/dav/uploads/ops/mm-${'0'.repeat(24)}` }
    const stales: ResumeState[] = [{ ...resume, key: keyAt(23) }, { ...resume, chunkSize: 4096 }, forgot]
    for (const stale of stales) {
      fake.requests.length = 0
      await adapter().put(key, file, stale, io(), signal)
      expect(fake.files.get(`${fake.filesRoot}Backups/Mongo/${key}`)!.equals(body)).toBe(true)
      // A new folder each time, every chunk sent again.
      const made = fake.requests.filter((r) => r.startsWith('MKCOL') && r.includes('/uploads/'))
      expect(made).toHaveLength(1)
      expect(made[0]).not.toContain(String(stale.dir).split('/').at(-1))
      expect(chunkPuts()).toHaveLength(3)
      await adapter().remove(key, signal)
    }
  })
})
