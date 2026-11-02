import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { WebdavConfigSchema } from '@mongo-manager/shared'
import { EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { createWebdavAdapter } from '../src/backup/destinations/webdav'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { slow } from './support/slowness'

/* Phase 3d-3b final review: the WebDAV adapter's findings, against a scripted server. */

interface Seen {
  method: string
  url: URL
  headers: Record<string, string>
  body: Buffer
  deadlineMs?: number
}
interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer | Readable
}
const handedOut: Readable[] = []
const endless = () =>
  new Readable({
    read() {
      this.push(Buffer.alloc(1024, 0x61))
    },
  })
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
        ...(r.deadlineMs !== undefined ? { deadlineMs: r.deadlineMs } : {}),
      }
      seen.push(s)
      const reply = await handler(s)
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

const SITE = 'https://dav.example.test'
const signal = new AbortController().signal
let clock = Date.UTC(2026, 9, 3, 12)
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
      folder: 'Backups',
      username: 'ops',
      ...over,
    }),
    secrets: { password: 'pw' },
    partBytes: opts.partBytes ?? 1000,
    now: () => clock++,
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  })
}
const multistatus = (entries: string[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`
const fileEntry = (href: string, size: string | null) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/>${size === null ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`
const dirEntry = (href: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
const keyAt = (i: number) =>
  remoteKeyFor(
    '',
    'gzip',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3, 0, 0, i),
  )
const KEY = keyAt(1)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-dav-final-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function local(size: number) {
  const body = Buffer.alloc(size, 3)
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

describe('WebDAV final review', () => {
  it('A1: refused and unwanted answers are dropped, never drained', async () => {
    const { egress } = scripted((r) =>
      r.method === 'PROPFIND' ? { status: 404, body: endless() } : { status: 500, body: endless() },
    )
    const a = make(egress, {}, { retries: 0 })
    expect(await a.stat(KEY, signal)).toBeNull()
    await expect(a.remove(KEY, signal)).rejects.toMatchObject({ reason: 'provider' })
    const ok = scripted(() => ({ status: 201, body: endless() }))
    await make(ok.egress).putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    expect(handedOut.length).toBeGreaterThan(3)
    for (const b of handedOut) expect(b.destroyed).toBe(true)
  })

  it('A4: an empty folder (the default) builds addresses without an empty segment', async () => {
    const { egress, seen } = scripted((r) =>
      r.method === 'PROPFIND'
        ? { status: 207, body: multistatus([dirEntry('/dav/'), fileEntry(`/dav/${KEY}`, '5')]) }
        : { status: 201 },
    )
    const a = make(egress, { folder: '' })
    await a.authCheck(signal)
    await a.stat(KEY, signal)
    await a.list(null, signal)
    await a.putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    expect(seen.length).toBeGreaterThan(3)
    for (const s of seen) expect(s.url.pathname, s.url.pathname).not.toContain('//')
    expect(seen[0]!.url.pathname).toBe('/dav/')
  })

  it('A4: lists the layout under an empty folder', async () => {
    const { egress } = scripted((r) => {
      const p = r.url.pathname
      if (p === '/dav/mongo-manager/')
        return { status: 207, body: multistatus([dirEntry(p), dirEntry('/dav/mongo-manager/2026/')]) }
      if (p === '/dav/mongo-manager/2026/')
        return { status: 207, body: multistatus([dirEntry(p), dirEntry('/dav/mongo-manager/2026/10/')]) }
      if (p === '/dav/mongo-manager/2026/10/')
        return { status: 207, body: multistatus([dirEntry(p), fileEntry(`/dav/${KEY}`, '5')]) }
      return { status: 404 }
    })
    const page = await make(egress, { folder: '' }).list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([KEY])
  })

  function nextcloud(opts: { move: Array<number | 'lost'>; size: string }) {
    const moves = [...opts.move]
    return scripted((r) => {
      if (r.method === 'MOVE') {
        const m = moves.shift()
        if (m === 'lost') throw new EgressError('network', 'The connection to the destination failed')
        return { status: m ?? 500 }
      }
      if (r.method === 'PROPFIND')
        return { status: 207, body: multistatus([fileEntry(r.url.pathname, opts.size)]) }
      return { status: 201 }
    })
  }

  it(
    'A5: a MOVE retried after its first answer was lost (412, or 404 for the chunk folder) is accepted when the file is whole',
    async () => {
      const f = local(2500)
      for (const second of [412, 404]) {
        const { egress } = nextcloud({ move: ['lost', second], size: '2500' })
        const saved: Array<ResumeState | null> = []
        await make(egress, { preset: 'nextcloud' }).put(KEY, f, null, io(saved), signal)
        expect(saved.at(-1)).toBeNull()
      }
    },
    slow(20_000),
  )

  it('A5: a 412 with a different file in place still fails', async () => {
    const f = local(2500)
    const { egress } = nextcloud({ move: [412], size: '7' })
    await expect(make(egress, { preset: 'nextcloud' }).put(KEY, f, null, io(), signal)).rejects.toMatchObject(
      {
        reason: 'conflict',
      },
    )
  })

  it('A12: a 206 that starts elsewhere than the offset is refused', async () => {
    const { egress } = scripted(() => ({
      status: 206,
      headers: { 'content-range': 'bytes 9-9/10' },
      body: '9',
    }))
    await expect(make(egress).get(KEY, 4, signal)).rejects.toThrow(/range/i)
    const ok = scripted(() => ({ status: 206, headers: { 'content-range': 'bytes 4-5/6' }, body: '45' }))
    expect((await buffer(await make(ok.egress).get(KEY, 4, signal))).toString()).toBe('45')
  })

  it('A14: a listing walks a bounded number of folders', async () => {
    let propfinds = 0
    const { egress } = scripted((r) => {
      propfinds++
      const p = r.url.pathname
      if (p === '/dav/Backups/mongo-manager/')
        return {
          status: 207,
          body: multistatus([
            dirEntry(p),
            ...Array.from({ length: 9999 - 1000 + 1 }, (_, i) => dirEntry(`${p}${1000 + i}/`)),
          ]),
        }
      // Every year holds 99 months.
      if (/\/\d{4}\/$/.test(p))
        return {
          status: 207,
          body: multistatus([
            dirEntry(p),
            ...Array.from({ length: 99 }, (_, i) => dirEntry(`${p}${String(i).padStart(2, '0')}/`)),
          ]),
        }
      return { status: 207, body: multistatus([dirEntry(p)]) }
    })
    await make(egress).list(null, signal)
    expect(propfinds).toBeLessThanOrEqual(500)
  })

  it('A14: the newest years and months are walked first', async () => {
    const walked: string[] = []
    const { egress } = scripted((r) => {
      const p = r.url.pathname
      walked.push(p)
      if (p === '/dav/Backups/mongo-manager/')
        return { status: 207, body: multistatus([dirEntry(p), dirEntry(`${p}2024/`), dirEntry(`${p}2026/`)]) }
      if (/\/\d{4}\/$/.test(p))
        return { status: 207, body: multistatus([dirEntry(p), dirEntry(`${p}01/`), dirEntry(`${p}10/`)]) }
      return { status: 207, body: multistatus([dirEntry(p)]) }
    })
    await make(egress).list(null, signal)
    expect(walked.slice(1, 3)).toEqual([
      '/dav/Backups/mongo-manager/2026/',
      '/dav/Backups/mongo-manager/2026/10/',
    ])
  })

  it('A15: a negative, fractional or non-numeric size is unknown, never a size', async () => {
    for (const size of ['-1', 'NaN', '1.5', '1e3', ' ']) {
      const { egress } = scripted(() => ({
        status: 207,
        body: multistatus([fileEntry(`/dav/Backups/${KEY}`, size)]),
      }))
      expect(await make(egress).stat(KEY, signal), size).toBeNull()
    }
    const { egress } = scripted(() => ({
      status: 207,
      body: multistatus([fileEntry(`/dav/Backups/${KEY}`, '12')]),
    }))
    expect(await make(egress).stat(KEY, signal)).toMatchObject({ size: 12 })
  })

  it('A16: small answers carry an overall deadline; uploads and the object download do not', async () => {
    const f = local(10)
    const { egress, seen } = scripted((r) =>
      r.method === 'PROPFIND'
        ? { status: 207, body: multistatus([fileEntry(r.url.pathname, '10')]) }
        : { status: 201, body: 'x' },
    )
    const a = make(egress)
    await a.stat(KEY, signal)
    await a.getSmall(`${KEY}.json`, 1024, signal)
    ;(await a.get(KEY, 0, signal)).destroy()
    await a.put(KEY, f, null, io(), signal)
    const by = (m: string) => seen.filter((s) => s.method === m).map((s) => s.deadlineMs !== undefined)
    expect(by('PROPFIND').every(Boolean)).toBe(true)
    expect(by('MKCOL').every(Boolean)).toBe(true)
    expect(by('GET')).toEqual([true, false])
    expect(by('PUT')).toEqual([false])
  })

  it('A20: an address with a query or a fragment is refused', () => {
    const { egress } = scripted(() => ({ status: 200 }))
    for (const url of [`${SITE}/dav/?x=1`, `${SITE}/dav/#frag`, `${SITE}/dav?`])
      expect(() => make(egress, { url }), url).toThrow(/query|fragment/i)
  })

  it('A21: a file needing more than 10 000 chunks gets larger chunks', async () => {
    const chunks: number[] = []
    const size = 25_000_000
    const f = { path: join(dir, 'sparse'), size, sha256: '0'.repeat(64), md5: '0'.repeat(32) }
    writeFileSync(f.path, Buffer.alloc(0))
    const { egress } = scripted((r) => {
      if (r.method === 'PUT' && /\/\d{5}$/.test(r.url.pathname)) {
        chunks.push(Number(r.headers['content-length']))
        // The rest is not sent: one chunk shows the size.
        throw new EgressError('aborted', 'enough')
      }
      return { status: 201 }
    })
    const saved: Array<ResumeState | null> = []
    await make(egress, { preset: 'nextcloud' }, { partBytes: 1000 })
      .put(KEY, f, null, io(saved), signal)
      .catch(() => undefined)
    const chunkSize = (saved[0] as { chunkSize: number }).chunkSize
    expect(Math.ceil(size / chunkSize)).toBeLessThanOrEqual(10_000)
    expect(chunks[0]).toBe(chunkSize)
  })
})
