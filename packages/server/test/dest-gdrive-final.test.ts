// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { GdriveConfigSchema } from '@mongo-manager/shared'
import { EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { createDriveAdapter } from '../src/backup/destinations/gdrive'
import type { GoogleTokens } from '../src/backup/destinations/google-auth'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'

/* Phase 3d-3b final review: the Drive adapter's findings, against a scripted Google. */

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
  body?: unknown
}
const handedOut: Readable[] = []
/** A body that never ends (a chunk per turn of the loop): only destroying it stops it. */
const endless = () =>
  new Readable({
    read() {
      setImmediate(() => this.destroyed || this.push(Buffer.alloc(1024, 0x61)))
    },
  })
const endlessBodies = new Set<Readable>()
const tracked = () => {
  const b = endless()
  endlessBodies.add(b)
  return b
}
const FOLDER = 'application/vnd.google-apps.folder'
const API = 'https://api.example.test'
const UP = 'https://up.example.test'
interface Node {
  id: string
  name: string
  parent: string
  folder: boolean
  size?: string
  body?: string
}

/** A scripted Drive over a small tree; `hook` answers first when it returns a reply. */
function drive(nodes: Node[], hook: (r: Seen) => Reply | null = () => null) {
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
      const reply = hook(s) ?? answer(s)
      const stream =
        reply.body instanceof Readable
          ? reply.body
          : Readable.from(
              reply.body === undefined
                ? []
                : [
                    Buffer.isBuffer(reply.body)
                      ? reply.body
                      : Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
                  ],
            )
      handedOut.push(stream)
      return { status: reply.status, headers: reply.headers ?? {}, body: stream }
    },
    buffer: () => Promise.reject(new Error('not used')),
    probe: () => Promise.reject(new Error('not used')),
    listed: () => false,
  }
  function answer(s: Seen): Reply {
    const p = s.url.pathname
    if (s.method === 'GET' && p === '/drive/v3/files') {
      const q = s.url.searchParams.get('q')!
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)![1]
      const folder = q.includes(`mimeType='${FOLDER}'`)
      const files = nodes
        .filter((n) => n.parent === parent && n.folder === folder && (name === undefined || n.name === name))
        .map((n) => ({ id: n.id, name: n.name, ...(n.size !== undefined ? { size: n.size } : {}) }))
      return { status: 200, body: { files } }
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)
    if (s.method === 'GET' && m) {
      const n = nodes.find((x) => x.id === decodeURIComponent(m[1]!))
      if (!n) return { status: 404, body: {} }
      if (s.url.searchParams.get('alt') === 'media') return { status: 200, body: n.body ?? '' }
      return {
        status: 200,
        body: { id: n.id, trashed: false, ...(n.size !== undefined ? { size: n.size } : {}) },
      }
    }
    return { status: 200, body: {} }
  }
  return { egress, seen }
}
afterEach(() => {
  handedOut.splice(0).forEach((b) => b.destroy())
  endlessBodies.forEach((b) => b.destroy())
  endlessBodies.clear()
})

const tokens = (o: { invalidated?: () => void } = {}) =>
  ({
    token: async () => 'ya29.access',
    invalidate: () => o.invalidated?.(),
  }) as unknown as GoogleTokens
const signal = new AbortController().signal
function make(egress: Egress, opts: { retries?: number; partBytes?: number; t?: GoogleTokens } = {}) {
  return createDriveAdapter({
    egress,
    hosts: { oauth: 'https://oauth.example.test', api: API, upload: UP },
    tokens: opts.t ?? tokens(),
    config: GdriveConfigSchema.parse({ auth: 'oauth', clientId: 'cid-00000001' }),
    account: 'ops@example.test',
    folderId: 'R',
    saveFolderId: () => undefined,
    partBytes: opts.partBytes ?? 1000,
    now: () => Date.UTC(2026, 9, 3),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  })
}
const keyAt = (i: number, year = 2026, month = 9) =>
  remoteKeyFor(
    '',
    'mmbak',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(year, month, 3, 0, 0, i),
  )
const KEY = keyAt(1)
/** The tree holding KEY: R / mongo-manager / 2026 / 10 / <name>. */
const tree = (size = '5', extra: Node[] = []): Node[] => [
  { id: 'R', name: 'Mongo Manager backups', parent: 'root', folder: true },
  { id: 'MM', name: 'mongo-manager', parent: 'R', folder: true },
  { id: 'Y', name: '2026', parent: 'MM', folder: true },
  { id: 'M', name: '10', parent: 'Y', folder: true },
  { id: 'F', name: KEY.split('/').at(-1)!, parent: 'M', folder: false, size, body: '0123456789' },
  ...extra,
]

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-drive-final-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function local(size: number) {
  const body = Buffer.alloc(size, 5)
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
const session = (r: Seen): Reply | null =>
  r.method === 'POST' && r.url.origin === UP
    ? { status: 200, headers: { location: `${UP}/upload/drive/v3/files?upload_id=s1` }, body: tracked() }
    : null

describe('Drive final review', () => {
  it('A1: answers that are not wanted are dropped, never drained', async () => {
    const f = local(10)
    const { egress } = drive(tree('10'), (r) => {
      const s = session(r)
      if (s) return s
      if (r.method === 'PUT') return { status: 200, body: { id: 'NEW' } }
      if (r.method === 'DELETE') return { status: 404, body: tracked() }
      return null
    })
    const a = make(egress)
    await a.putSmall(`${KEY}.json`, Buffer.from('{}'), signal)
    await a.remove(KEY, signal)
    await a.abandon({ key: KEY, session: `${UP}/upload/x`, offset: 0 }, signal)
    await a.put(KEY, f, null, io(), signal).catch(() => undefined)
    expect(endlessBodies.size).toBeGreaterThanOrEqual(3)
    for (const b of endlessBodies) expect(b.destroyed).toBe(true)
  })

  it('A10: a 308 that does not move forward ends the upload instead of looping', async () => {
    const f = local(2500)
    let puts = 0
    const { egress } = drive(tree(), (r) => {
      const s = session(r)
      if (s) return s
      if (r.method === 'PUT') {
        puts++
        if (puts > 20) throw new Error('never stopped')
        return { status: 308, headers: { range: 'bytes=0-999' } }
      }
      return null
    })
    await expect(make(egress).put(KEY, f, null, io(), signal)).rejects.toMatchObject({ reason: 'provider' })
    expect(puts).toBeLessThanOrEqual(3)
  })

  it('A10: a 308 that reports the whole file asks for the result, never an empty range', async () => {
    const f = local(2500)
    const ranges: string[] = []
    const { egress } = drive(
      tree('2500', [{ id: 'NEW', name: 'x', parent: 'M', folder: false, size: '2500' }]),
      (r) => {
        const s = session(r)
        if (s) return s
        if (r.method === 'PUT') {
          ranges.push(r.headers['content-range']!)
          if (r.headers['content-range'] === 'bytes */2500') return { status: 200, body: { id: 'NEW' } }
          return { status: 308, headers: { range: 'bytes=0-2499' } }
        }
        return null
      },
    )
    const done = await make(egress).put(KEY, f, null, io(), signal)
    expect(done.ref).toBe('NEW')
    expect(ranges).toEqual(['bytes 0-999/2500', 'bytes */2500'])
  })

  it('A11: a revoked access token is refreshed once even when no retry is allowed', async () => {
    let invalidated = 0
    let first = true
    const { egress } = drive(tree(), () => {
      if (first) {
        first = false
        return { status: 401, body: {} }
      }
      return null
    })
    const a = make(egress, { retries: 0, t: tokens({ invalidated: () => invalidated++ }) })
    expect(await a.stat(KEY, signal)).toMatchObject({ size: 5 })
    expect(invalidated).toBe(1)
    // A second 401 in a row is a lost connection.
    let n = 0
    const again = drive(tree(), () => (n++ < 2 ? { status: 401, body: {} } : null))
    await expect(make(again.egress, { retries: 0 }).stat(KEY, signal)).rejects.toMatchObject({
      reason: 'reconnect',
    })
  })

  it('A12: a resumed download skips a 200 to the offset and refuses a 206 that starts elsewhere', async () => {
    const plain = drive(tree('10'))
    expect((await buffer(await make(plain.egress).get(KEY, 4, signal))).toString()).toBe('456789')
    const late = drive(tree('10'), (r) =>
      r.url.searchParams.get('alt') === 'media'
        ? { status: 206, headers: { 'content-range': 'bytes 6-9/10' }, body: '6789' }
        : null,
    )
    await expect(make(late.egress).get(KEY, 4, signal)).rejects.toThrow(/range/i)
  })

  it('A13: only year and month folders are walked, newest first, within a bounded number of calls', async () => {
    const bad: Node[] = [
      { id: 'Ybad', name: '..', parent: 'MM', folder: true },
      { id: 'Y5', name: '20261', parent: 'MM', folder: true },
      { id: 'Mbad', name: 'x1', parent: 'Y', folder: true },
      { id: 'Y24', name: '2024', parent: 'MM', folder: true },
    ]
    const { egress, seen } = drive(tree('5', bad))
    const page = await make(egress).list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([KEY])
    const parentsAsked = seen
      .map((s) => /'([^']*)' in parents/.exec(s.url.searchParams.get('q') ?? '')?.[1])
      .filter(Boolean)
    for (const id of ['Ybad', 'Y5', 'Mbad']) expect(parentsAsked).not.toContain(id)
    expect(parentsAsked.indexOf('Y')).toBeLessThan(parentsAsked.indexOf('Y24'))
    // A hostile tree: a thousand years of twelve months each.
    const years: Node[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `y${i}`,
      name: String(1000 + i),
      parent: 'MM',
      folder: true,
    }))
    const months: Node[] = years.flatMap((y) =>
      Array.from({ length: 12 }, (_, m) => ({
        id: `${y.id}m${m}`,
        name: String(m + 1).padStart(2, '0'),
        parent: y.id,
        folder: true,
      })),
    )
    const hostile = drive([...tree('5').slice(0, 2), ...years, ...months])
    await make(hostile.egress).list(null, signal)
    expect(hostile.seen.length).toBeLessThanOrEqual(400)
  })

  it('A15: a size that is missing or not a non-negative integer is refused', async () => {
    for (const size of [undefined, '-1', 'abc', '1.5']) {
      const nodes = tree()
      if (size === undefined) delete nodes[4]!.size
      else nodes[4]!.size = size
      const { egress } = drive(nodes)
      await expect(make(egress).stat(KEY, signal), String(size)).rejects.toMatchObject({ reason: 'provider' })
    }
  })

  it('A16: small answers carry an overall deadline; chunks and the media download do not', async () => {
    const f = local(10)
    const { egress, seen } = drive(
      tree('10', [{ id: 'NEW', name: 'x', parent: 'M', folder: false, size: '10' }]),
      (r) => {
        const s = session(r)
        if (s) return { ...s, body: undefined }
        if (r.method === 'PUT') return { status: 200, body: { id: 'NEW' } }
        return null
      },
    )
    const a = make(egress)
    await a.put(KEY, f, null, io(), signal).catch(() => undefined)
    ;(await a.get(KEY, 0, signal)).destroy()
    const chunk = seen.filter((s) => s.method === 'PUT')
    const media = seen.filter((s) => s.url.searchParams.get('alt') === 'media')
    const small = seen.filter((s) => !chunk.includes(s) && !media.includes(s))
    expect(chunk.length).toBe(1)
    expect(media.length).toBe(1)
    expect(chunk.every((s) => s.deadlineMs === undefined)).toBe(true)
    expect(media.every((s) => s.deadlineMs === undefined)).toBe(true)
    expect(small.length).toBeGreaterThan(3)
    expect(small.every((s) => s.deadlineMs !== undefined)).toBe(true)
  })
})
