// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { GdriveConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import {
  GoogleTokens,
  parseServiceAccountKey,
  pollDeviceFlow,
  startDeviceFlow,
  type GoogleHosts,
} from '../src/backup/destinations/google-auth'
import { createDriveAdapter } from '../src/backup/destinations/gdrive'
import { DeviceFlows } from '../src/backup/destinations/device-flows'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { DestinationError, type ResumeState } from '../src/backup/destinations/types'
import { installDrive, startFakeGoogle, type DriveFile, type FakeGoogle } from './support/fake-google'
import { startHttpsServer } from './support/https-server'

/**
 * Phase 3d-3b spec §2.4: the Drive adapter and Google sign-in against a provider that misbehaves —
 * lies about sizes and ids, answers too much or garbage, redirects, revokes tokens mid-upload.
 */
type Server = Awaited<ReturnType<typeof startHttpsServer>>
type DriveHandler = NonNullable<Parameters<FakeGoogle['setDrive']>[0]>
type Override = (req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) => boolean

const MiB = 1024 * 1024
const KiB = 1024
const FOLDER = 'application/vnd.google-apps.folder'
const CID = 'cid-00000001'
const signal = new AbortController().signal
const egress = createEgress({ networks: ['127.0.0.1/32'] })

let g: FakeGoogle
let base: DriveHandler
let override: Override | null = null
const seen: Array<{ method: string; url: URL; headers: IncomingHttpHeaders }> = []
let evil: Server
const evilHits: string[] = []
let oauth: Server
let oauthHosts: GoogleHosts
let script: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, r) => r.end()
const oauthHits: Array<{ path: string; body: string; headers: IncomingHttpHeaders }> = []
let dir: string

const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.statusCode = status
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  if (body === undefined) return void res.end()
  res.setHeader('content-type', 'application/json')
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

beforeAll(async () => {
  g = await startFakeGoogle()
  // The shared Drive handler, captured so a test can answer one request and leave the rest to it.
  installDrive({
    ...g,
    setDrive: (h) => {
      base = h!
    },
  })
  g.setDrive((req, res, url, body) => {
    seen.push({ method: req.method!, url, headers: req.headers })
    if (override?.(req, res, url, body)) return
    base(req, res, url, body)
  })
  evil = await startHttpsServer((req, res) => {
    evilHits.push(`${req.method} ${req.url} ${String(req.headers.authorization ?? '')}`)
    send(res, 200, {})
  })
  oauth = await startHttpsServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString()
    oauthHits.push({ path: new URL(req.url!, 'https://x').pathname, body, headers: req.headers })
    script(req, res, body)
  })
  oauthHosts = { oauth: oauth.url, api: oauth.url, upload: oauth.url, caPem: oauth.caPem }
  dir = mkdtempSync(join(tmpdir(), 'mm-drive-more-'))
})
afterAll(async () => {
  await Promise.all([g?.close(), evil?.close(), oauth?.close()])
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  g.files.clear()
  g.sessions.clear()
  g.revoked.clear()
  g.requests.length = 0
  g.knobs.checksum = 'sha256'
  g.knobs.sessionOrigin = null
  override = null
  seen.length = 0
  evilHits.length = 0
  oauthHits.length = 0
  script = (_q, r) => r.end()
})

function drive(
  o: {
    config?: Record<string, unknown>
    folderId?: string | null
    account?: string | null
    retries?: number
    partBytes?: number
    now?: () => number
  } = {},
) {
  const saved: string[] = []
  const tokens = new GoogleTokens({
    egress,
    hosts: g.hosts,
    source: { kind: 'oauth', clientId: CID, clientSecret: 'client-secret-1', refreshToken: '1//refresh-1' },
    now: () => Date.now(),
  })
  const a = createDriveAdapter({
    egress,
    hosts: g.hosts,
    tokens,
    config: GdriveConfigSchema.parse({ auth: 'oauth', clientId: CID, ...o.config }),
    account: o.account ?? null,
    folderId: o.folderId ?? null,
    saveFolderId: (id) => saved.push(id),
    partBytes: o.partBytes ?? 16 * MiB,
    now: o.now ?? (() => Date.now()),
    ...(o.retries !== undefined ? { retries: o.retries } : {}),
  })
  return { a, saved }
}

function local(size: number, fill = 9) {
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i++) body[i] = (i * 31 + fill) & 0xff
  const path = join(dir, `f-${randomUUID()}`)
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

function recorder() {
  const saved: Array<ResumeState | null> = []
  const progress: number[] = []
  return {
    saved,
    progress,
    io: {
      progress: (n: number) => void progress.push(n),
      saveResume: (s: ResumeState | null) => void saved.push(s && structuredClone(s)),
    },
  }
}

const add = (name: string, parents: string[], body?: Buffer): DriveFile => {
  const f: DriveFile = {
    id: `f-${randomUUID()}`,
    name,
    mimeType: body ? 'application/octet-stream' : FOLDER,
    parents,
    body: body ?? Buffer.alloc(0),
    trashed: false,
  }
  g.files.set(f.id, f)
  return f
}
/** Mongo Manager backups / mongo-manager / 2026 / 10, made as Drive would hold it. */
function layout() {
  const root = add('Mongo Manager backups', ['root'])
  const mm = add('mongo-manager', [root.id])
  const y = add('2026', [mm.id])
  const m = add('10', [y.id])
  return { root, mm, y, m }
}
const keyOf = (id: string) => remoteKeyFor('', 'mmbak', id, Date.UTC(2026, 9, 3))
const key = keyOf('7c9e6679-7425-40de-944b-e07fc1f90ae7')
const nameOf = (k: string) => k.slice(k.lastIndexOf('/') + 1)
const sessionUrl = (id: string, origin = g.url) =>
  `${origin}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`
const isListing = (req: IncomingMessage, url: URL) =>
  req.method === 'GET' && url.pathname === '/drive/v3/files' && url.searchParams.has('q')
const isProbe = (req: IncomingMessage) =>
  req.method === 'PUT' && String(req.headers['content-range']).startsWith('bytes */')
const dataPuts = () =>
  seen.filter((s) => s.method === 'PUT' && !String(s.headers['content-range']).startsWith('bytes */'))
const tokenPosts = () => g.requests.filter((r) => r === 'POST /token').length

describe('Drive folders: My Drive, Shared Drives and the stored folder id', () => {
  it('works inside a Shared Drive: every query names the drive and the folder is made in it', async () => {
    const SD = '0ASharedDrive01'
    const { a, saved } = drive({ config: { sharedDriveId: SD } })
    await a.authCheck(signal)
    expect(g.files.get(saved[0]!)).toMatchObject({ name: 'Mongo Manager backups', parents: [SD] })
    const { body, file } = local(3000)
    const out = await a.put(key, file, null, recorder().io, signal)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect((await a.list(null, signal)).items.map((i) => i.key)).toEqual([key])
    const queries = seen.filter((s) => s.method === 'GET' && s.url.searchParams.has('q'))
    expect(queries.length).toBeGreaterThan(5)
    for (const q of queries)
      expect(Object.fromEntries(q.url.searchParams)).toMatchObject({
        corpora: 'drive',
        driveId: SD,
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
      })
    expect(queries[0]!.url.searchParams.get('q')).toContain(`'${SD}' in parents`)
  })

  it('in My Drive, never names a drive and starts from root', async () => {
    const { a, saved } = drive()
    await a.authCheck(signal)
    expect(g.files.get(saved[0]!)!.parents).toEqual(['root'])
    const queries = seen.filter((s) => s.method === 'GET' && s.url.searchParams.has('q'))
    expect(queries[0]!.url.searchParams.get('q')).toContain(`'root' in parents`)
    for (const q of queries) {
      expect(q.url.searchParams.has('driveId')).toBe(false)
      expect(q.url.searchParams.has('corpora')).toBe(false)
    }
  })

  it('reuses a stored folder without searching, and replaces one that was trashed or deleted', async () => {
    const first = drive()
    await first.a.authCheck(signal)
    const id1 = first.saved[0]!
    seen.length = 0
    const again = drive({ folderId: id1 })
    await again.a.authCheck(signal)
    expect(again.saved).toEqual([])
    expect(seen.some((s) => s.url.searchParams.has('q') || s.method === 'POST')).toBe(false)

    // Trashed in the Drive UI: still answers by id, but must not be written into.
    g.files.get(id1)!.trashed = true
    override = (_req, res, url) => {
      if (url.pathname !== `/drive/v3/files/${id1}`) return false
      send(res, 200, { id: id1, trashed: true })
      return true
    }
    const trashed = drive({ folderId: id1 })
    await trashed.a.authCheck(signal)
    expect(trashed.saved).toHaveLength(1)
    expect(trashed.saved[0]).not.toBe(id1)
    expect(g.files.get(trashed.saved[0]!)).toMatchObject({ trashed: false, parents: ['root'] })

    // Deleted for good: the stored id answers 404.
    override = null
    g.files.delete(trashed.saved[0]!)
    const gone = drive({ folderId: trashed.saved[0]! })
    await gone.a.authCheck(signal)
    expect(gone.saved).toHaveLength(1)
    expect(gone.saved[0]).not.toBe(trashed.saved[0])
    expect(g.files.has(gone.saved[0]!)).toBe(true)
  })

  it('adopts an existing folder of the same name rather than making a duplicate', async () => {
    const existing = add('Mongo Manager backups', ['root'])
    const { a, saved } = drive({ folderId: 'f-no-longer-there' })
    await a.authCheck(signal)
    expect(saved).toEqual([existing.id])
    expect(seen.some((s) => s.method === 'POST')).toBe(false)
  })

  it('asks for the account only when it is not known, and tolerates an answer without one', async () => {
    const known = drive({ account: 'known@example.com' })
    expect(await known.a.authCheck(signal)).toEqual({ account: 'known@example.com' })
    expect(seen.some((s) => s.url.pathname === '/drive/v3/about')).toBe(false)
    override = (_req, res, url) => {
      if (url.pathname !== '/drive/v3/about') return false
      send(res, 200, { user: {} })
      return true
    }
    expect(await drive().a.authCheck(signal)).toEqual({})
  })

  it('remembers the folders it has walked, so a second upload does not search again', async () => {
    const { a } = drive()
    await a.put(key, local(100).file, null, recorder().io, signal)
    const named = (n: string) =>
      seen.filter((s) => s.url.searchParams.get('q')?.startsWith(`name='${n}'`)).length
    expect([named('mongo-manager'), named('2026'), named('10')]).toEqual([1, 1, 1])
    await a.put(keyOf('8d9e6679-7425-40de-944b-e07fc1f90ae7'), local(100).file, null, recorder().io, signal)
    expect([named('mongo-manager'), named('2026'), named('10')]).toEqual([1, 1, 1])
    expect([...g.files.values()].filter((f) => f.name === '10')).toHaveLength(1)
  })
})

describe('Drive reads: stat, get, getSmall, list, remove', () => {
  it('reading a path that does not exist creates nothing and sends no write', async () => {
    const { a } = drive()
    await a.authCheck(signal)
    const before = g.files.size
    seen.length = 0
    expect(await a.stat(key, signal)).toBeNull()
    await expect(a.get(key, 0, signal)).rejects.toMatchObject({ reason: 'not_found' })
    expect(await a.getSmall(`${key}.json`, 1024, signal)).toBeNull()
    await a.remove(key, signal)
    expect(await a.list(null, signal)).toEqual({ items: [], cursor: null })
    expect(g.files.size).toBe(before)
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([])
  })

  it('refuses a key outside the layout before asking Drive anything', async () => {
    const { a } = drive()
    for (const bad of ['mongo-manager/../secrets/x.mmbak', 'mongo-manager//x', '/abs/x', 'a/./b'])
      await expect(a.stat(bad, signal)).rejects.toMatchObject({ reason: 'path' })
    expect(seen).toEqual([])
  })

  it('stat reports what Drive holds, with only the checksums it gives', async () => {
    const { root, m } = layout()
    const body = Buffer.from('0123456789')
    const f = add(nameOf(key), [m.id], body)
    const { a } = drive({ folderId: root.id })
    expect(await a.stat(key, signal)).toEqual({
      size: 10,
      archived: false,
      ref: f.id,
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('hex'),
    })
    g.knobs.checksum = 'none'
    expect(await a.stat(key, signal)).toEqual({ size: 10, archived: false, ref: f.id })
  })

  it('get asks for a range only when resuming', async () => {
    const { root, m } = layout()
    const { body } = local(1000)
    add(nameOf(key), [m.id], body)
    const { a } = drive({ folderId: root.id })
    expect((await buffer(await a.get(key, 0, signal))).equals(body)).toBe(true)
    const media = () => seen.filter((s) => s.url.searchParams.get('alt') === 'media')
    expect(media().at(-1)!.headers.range).toBeUndefined()
    expect((await buffer(await a.get(key, 600, signal))).equals(body.subarray(600))).toBe(true)
    expect(media().at(-1)!.headers.range).toBe('bytes=600-')
  })

  it('getSmall refuses a file listed larger than the limit without downloading it', async () => {
    const { root, m } = layout()
    add(`${nameOf(key)}.json`, [m.id], Buffer.alloc(2048, 32))
    const { a } = drive({ folderId: root.id })
    await expect(a.getSmall(`${key}.json`, 1024, signal)).rejects.toMatchObject({ reason: 'too_large' })
    expect(seen.some((s) => s.url.searchParams.get('alt') === 'media')).toBe(false)
  })

  it('getSmall stays bounded when Drive lists a small size but sends a large body', async () => {
    const { root, m } = layout()
    const manifest = add(`${nameOf(key)}.json`, [m.id], Buffer.alloc(MiB, 32))
    override = (req, res, url) => {
      if (!isListing(req, url) || !url.searchParams.get('q')!.startsWith(`name='${manifest.name}'`))
        return false
      send(res, 200, { files: [{ id: manifest.id, name: manifest.name, size: '10' }] })
      return true
    }
    const { a } = drive({ folderId: root.id })
    const got = await a.getSmall(`${key}.json`, 64 * KiB, signal).then(
      (b) => ({ resolvedWithBytes: b?.length }),
      (e: unknown) => e,
    )
    expect(got).toMatchObject({ reason: 'too_large' })
  })

  it('lists newest first in pages of 1000 and drops names that are not the layout', async () => {
    const { root, mm, m } = layout()
    const one = Buffer.from('abc')
    for (let i = 0; i < 1001; i++)
      add(`mm-20261003-120000-${i.toString(16).padStart(8, '0')}.mmbak`, [m.id], one)
    add('../../escape.mmbak', [m.id], one)
    add('notes.txt', [m.id], one)
    add('mm-20261003-120000-0000zzzz.mmbak', [m.id], one)
    const dotdot = add('..', [mm.id])
    const m2 = add('10', [dotdot.id])
    add('mm-20261003-120000-ffffffff.mmbak', [m2.id], one)
    const { a } = drive({ folderId: root.id })
    const p1 = await a.list(null, signal)
    expect(p1.items).toHaveLength(1000)
    expect(p1.cursor).toBe('1000')
    const p2 = await a.list(p1.cursor, signal)
    expect(p2.items).toHaveLength(1)
    expect(p2.cursor).toBeNull()
    const keys = [...p1.items, ...p2.items].map((i) => i.key)
    expect(new Set(keys).size).toBe(1001)
    expect(keys).toEqual([...keys].sort().reverse())
    expect(
      keys.every((k) => /^mongo-manager\/2026\/10\/mm-20261003-120000-[0-9a-f]{8}\.mmbak$/.test(k)),
    ).toBe(true)
    expect(p1.items[0]).toMatchObject({
      key: 'mongo-manager/2026/10/mm-20261003-120000-000003e8.mmbak',
      size: 3,
      modifiedAt: Date.parse('2026-10-03T12:00:00.000Z'),
      archived: false,
    })
  })

  it('follows nextPageToken, and reads a missing size or time as 0 and unknown', async () => {
    const { root, m } = layout()
    const pages: Array<string | null> = []
    override = (req, res, url) => {
      if (!isListing(req, url) || !url.searchParams.get('q')!.startsWith(`'${m.id}' in parents`)) return false
      const token = url.searchParams.get('pageToken')
      pages.push(token)
      if (!token)
        send(res, 200, {
          files: [{ id: 'f-a', name: 'mm-20261003-120000-0000000a.mmbak' }],
          nextPageToken: 'page-2',
        })
      else
        send(res, 200, {
          files: [
            {
              id: 'f-b',
              name: 'mm-20261003-120000-0000000b.mmbak',
              size: '42',
              modifiedTime: '2026-10-02T00:00:00.000Z',
            },
          ],
        })
      return true
    }
    const { a } = drive({ folderId: root.id })
    const { items } = await a.list(null, signal)
    expect(pages).toEqual([null, 'page-2'])
    expect(items).toEqual([
      {
        key: 'mongo-manager/2026/10/mm-20261003-120000-0000000b.mmbak',
        size: 42,
        modifiedAt: Date.parse('2026-10-02T00:00:00.000Z'),
        archived: false,
        ref: 'f-b',
      },
      {
        key: 'mongo-manager/2026/10/mm-20261003-120000-0000000a.mmbak',
        size: 0,
        modifiedAt: null,
        archived: false,
        ref: 'f-a',
      },
    ])
  })

  it('stops paging when Drive hands out page tokens with nothing on the pages', async () => {
    const { root, m } = layout()
    let pages = 0
    override = (req, res, url) => {
      if (!isListing(req, url) || !url.searchParams.get('q')!.startsWith(`'${m.id}' in parents`)) return false
      pages++
      // A safety valve so the test ends even if the adapter does not stop by itself.
      send(res, 200, pages < 60 ? { files: [], nextPageToken: `p-${pages}` } : { files: [] })
      return true
    }
    const { a } = drive({ folderId: root.id })
    expect((await a.list(null, signal)).items).toEqual([])
    expect(pages).toBeLessThanOrEqual(20)
  })

  it('refuses a listing larger than 8 MiB', async () => {
    const { root, m } = layout()
    override = (req, res, url) => {
      if (!isListing(req, url) || !url.searchParams.get('q')!.startsWith(`'${m.id}' in parents`)) return false
      send(res, 200, `{"files":[],"pad":"${'x'.repeat(9 * MiB)}"}`)
      return true
    }
    const { a } = drive({ folderId: root.id })
    await expect(a.list(null, signal)).rejects.toMatchObject({ reason: 'too_large' })
  })

  it('remove is quiet when the file went away in between', async () => {
    const { root, m } = layout()
    const f = add(nameOf(key), [m.id], Buffer.from('x'))
    override = (req, res) => {
      if (req.method !== 'DELETE') return false
      send(res, 404, { error: { code: 404 } })
      return true
    }
    const { a } = drive({ folderId: root.id })
    await a.remove(key, signal)
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.url.pathname)).toEqual([
      `/drive/v3/files/${f.id}`,
    ])
  })
})

describe('Drive uploads: sessions, resume and verification', () => {
  it('resumes a session from the range Drive reports', async () => {
    const { root, m } = layout()
    const { body, file } = local(1000)
    g.sessions.set('s-part', {
      name: nameOf(key),
      parents: [m.id],
      size: 1000,
      received: [body.subarray(0, 400)],
    })
    const r = recorder()
    const { a } = drive({ folderId: root.id })
    const out = await a.put(key, file, { key, session: sessionUrl('s-part'), offset: 400 }, r.io, signal)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(seen.some((s) => s.method === 'POST')).toBe(false)
    expect(dataPuts().map((s) => s.headers['content-range'])).toEqual(['bytes 400-999/1000'])
    expect(r.progress[0]).toBe(400)
    expect(r.progress.at(-1)).toBe(1000)
    expect(r.saved.at(-1)).toBeNull()
  })

  it('starts again from 0 when the resumed session holds nothing yet', async () => {
    const { root, m } = layout()
    const { body, file } = local(1000)
    g.sessions.set('s-empty', { name: nameOf(key), parents: [m.id], size: 1000, received: [] })
    const { a } = drive({ folderId: root.id })
    const out = await a.put(
      key,
      file,
      { key, session: sessionUrl('s-empty'), offset: 700 },
      recorder().io,
      signal,
    )
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(dataPuts().map((s) => s.headers['content-range'])).toEqual(['bytes 0-999/1000'])
  })

  it('takes a session Drive already finished without sending a byte again', async () => {
    const { root, m } = layout()
    const { body, file } = local(1000)
    const done = add(nameOf(key), [m.id], body)
    override = (req, res, url) => {
      if (!isProbe(req) || url.searchParams.get('upload_id') !== 's-done') return false
      send(res, 200, { id: done.id })
      return true
    }
    const r = recorder()
    const { a } = drive({ folderId: root.id })
    const out = await a.put(key, file, { key, session: sessionUrl('s-done'), offset: 1000 }, r.io, signal)
    expect(out).toEqual({ ref: done.id, checksums: { sha256: file.sha256, md5: file.md5 } })
    expect(dataPuts()).toEqual([])
    expect(r.progress.at(-1)).toBe(1000)
  })

  it('opens a new session when the stored one expired (404, 410)', async () => {
    for (const status of [404, 410]) {
      g.files.clear()
      const { root } = layout()
      override = (req, res, url) => {
        if (!isProbe(req) || url.searchParams.get('upload_id') !== 's-old') return false
        send(res, status, {})
        return true
      }
      const { body, file } = local(500)
      const { a } = drive({ folderId: root.id })
      const out = await a.put(
        key,
        file,
        { key, session: sessionUrl('s-old'), offset: 100 },
        recorder().io,
        signal,
      )
      expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
      expect(
        seen.filter((s) => s.method === 'POST' && s.url.pathname === '/upload/drive/v3/files'),
      ).toHaveLength(1)
      seen.length = 0
    }
  })

  it('never sends a stored session to another host, nor one stored for a different key', async () => {
    const { root } = layout()
    const { body, file } = local(500)
    const { a } = drive({ folderId: root.id })
    const tampered = { key, session: sessionUrl('stolen', evil.url), offset: 100 }
    const out = await a.put(key, file, tampered, recorder().io, signal)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(evilHits).toEqual([])
    await a.put(key, file, { key, session: 'not a url', offset: 0 }, recorder().io, signal)
    seen.length = 0
    g.sessions.set('s-other', { name: 'other', parents: [root.id], size: 500, received: [] })
    const r = recorder()
    await a.put(
      key,
      file,
      { key: keyOf('11111111-7425-40de-944b-e07fc1f90ae7'), session: sessionUrl('s-other'), offset: 0 },
      r.io,
      signal,
    )
    expect(seen.some((s) => s.url.searchParams.get('upload_id') === 's-other')).toBe(false)
    expect(g.sessions.has('s-other')).toBe(true)
    expect(r.saved[0]).toMatchObject({ key, offset: 0 })
    expect((r.saved[0] as { session: string }).session.startsWith(`${g.url}/`)).toBe(true)
  })

  it('refuses a resumed range past the end of the file', async () => {
    const { root, m } = layout()
    const { file } = local(1000)
    g.sessions.set('s-liar', { name: nameOf(key), parents: [m.id], size: 1000, received: [] })
    override = (req, res, url) => {
      if (!isProbe(req) || url.searchParams.get('upload_id') !== 's-liar') return false
      send(res, 308, undefined, { range: 'bytes=0-999999' })
      return true
    }
    const { a } = drive({ folderId: root.id, retries: 0 })
    await expect(
      a.put(key, file, { key, session: sessionUrl('s-liar'), offset: 0 }, recorder().io, signal),
    ).rejects.toBeInstanceOf(DestinationError)
    expect(dataPuts()).toEqual([])
  })

  it('refuses a new session without an address, and a session creation that redirects', async () => {
    const { root } = layout()
    const { file } = local(100)
    override = (req, res, url) => {
      if (req.method !== 'POST' || url.searchParams.get('uploadType') !== 'resumable') return false
      send(res, 200, {})
      return true
    }
    const { a } = drive({ folderId: root.id })
    await expect(a.put(key, file, null, recorder().io, signal)).rejects.toMatchObject({ reason: 'provider' })
    override = (req, res, url) => {
      if (req.method !== 'POST' || url.searchParams.get('uploadType') !== 'resumable') return false
      send(res, 302, undefined, { location: `${evil.url}/upload/steal` })
      return true
    }
    await expect(a.put(key, file, null, recorder().io, signal)).rejects.toMatchObject({ reason: 'redirect' })
    expect(evilHits).toEqual([])
    expect(dataPuts()).toEqual([])
  })

  it('refuses an upload Drive reports with another file id, a different size or no checksum match', async () => {
    const { root, mm } = layout()
    const elsewhere = add('elsewhere.mmbak', [mm.id], Buffer.alloc(1000, 1))
    const { file } = local(1000)
    const { a } = drive({ folderId: root.id })
    // 1. The upload answer names a file in another folder.
    override = (req, res, url) => {
      if (req.method !== 'PUT' || url.pathname !== '/upload/drive/v3/files') return false
      send(res, 200, { id: elsewhere.id })
      return true
    }
    await expect(a.put(key, file, null, recorder().io, signal)).rejects.toMatchObject({ reason: 'verify' })
    // 2. Drive says it holds one byte more, with the right checksum.
    override = (req, res, url) => {
      const m = /^\/drive\/v3\/files\/(f-[^/]+)$/.exec(url.pathname)
      if (req.method !== 'GET' || !m || !url.searchParams.get('fields')?.includes('sha256Checksum'))
        return false
      send(res, 200, { id: m[1], size: String(file.size + 1), sha256Checksum: file.sha256 })
      return true
    }
    await expect(a.put(key, file, null, recorder().io, signal)).rejects.toMatchObject({ reason: 'verify' })
    // 3. No checksum at all: the size alone decides.
    override = null
    g.knobs.checksum = 'none'
    expect((await a.put(key, file, null, recorder().io, signal)).checksums).toEqual({})
    override = (req, res, url) => {
      const m = /^\/drive\/v3\/files\/(f-[^/]+)$/.exec(url.pathname)
      if (req.method !== 'GET' || !m || !url.searchParams.get('fields')?.includes('md5Checksum')) return false
      send(res, 200, { id: m[1], size: String(file.size - 1) })
      return true
    }
    await expect(a.put(key, file, null, recorder().io, signal)).rejects.toMatchObject({ reason: 'verify' })
  })

  it('a token revoked mid-upload is refreshed once and the upload carries on', async () => {
    const { root } = layout()
    const { body, file } = local(MiB)
    let revoked = false
    const io = {
      progress: () => undefined,
      saveResume: (s: ResumeState | null) => {
        if (!revoked && s && Number(s.offset) >= 256 * KiB) {
          revoked = true
          g.tokens.clear()
        }
      },
    }
    const { a } = drive({ folderId: root.id, partBytes: 256 * KiB })
    const out = await a.put(key, file, null, io, signal)
    expect(revoked).toBe(true)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(tokenPosts()).toBe(2)
    // Five PUTs reached Google; the one refused for the stale token never reached Drive and was sent again.
    expect(g.requests.filter((r) => r === 'PUT /upload/drive/v3/files')).toHaveLength(5)
    expect(dataPuts().map((s) => s.headers['content-range'])).toEqual([
      'bytes 0-262143/1048576',
      'bytes 262144-524287/1048576',
      'bytes 524288-786431/1048576',
      'bytes 786432-1048575/1048576',
    ])
  })

  it('a refresh token refused mid-upload asks to reconnect and keeps the session to resume', async () => {
    const { root } = layout()
    const { body, file } = local(MiB)
    const r = recorder()
    let revoked = false
    const io = {
      progress: r.io.progress,
      saveResume: (s: ResumeState | null) => {
        r.io.saveResume(s)
        if (!revoked && s && Number(s.offset) >= 256 * KiB) {
          revoked = true
          g.tokens.clear()
          g.revoked.add('1//refresh-1')
        }
      },
    }
    const { a } = drive({ folderId: root.id, partBytes: 256 * KiB })
    await expect(a.put(key, file, null, io, signal)).rejects.toMatchObject({ reason: 'reconnect' })
    const last = r.saved.at(-1)!
    expect(last).toMatchObject({ key, offset: 256 * KiB })
    g.revoked.clear()
    const again = drive({ folderId: root.id, partBytes: 256 * KiB })
    seen.length = 0
    const out = await again.a.put(key, file, last, recorder().io, signal)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(dataPuts()[0]!.headers['content-range']).toBe('bytes 262144-524287/1048576')
  })
})

describe('Drive errors: mapping, Retry-After and hostile answers', () => {
  const aboutAnswers = (answer: (n: number, res: ServerResponse) => void) => {
    let n = 0
    override = (_req, res, url) => {
      if (url.pathname !== '/drive/v3/about') return false
      answer(n++, res)
      return true
    }
    return () => n
  }

  it('asks to reconnect when Google still refuses the access token after a refresh', async () => {
    const { root } = layout()
    const calls = aboutAnswers((_n, res) => send(res, 401, { error: { code: 401 } }))
    const { a } = drive({ folderId: root.id })
    const e = await a.authCheck(signal).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DestinationError)
    expect(e).toMatchObject({ reason: 'reconnect', extra: { status: 401 } })
    expect(calls()).toBe(2)
    expect(tokenPosts()).toBe(2)
  })

  it('maps Drive refusals to reasons, trusting no reason from an answer too large or not JSON', async () => {
    const { root } = layout()
    const why = (reason: string) => ({ error: { code: 403, errors: [{ reason }] } })
    const cases: Array<[number, unknown, string, number]> = [
      [403, why('storageQuotaExceeded'), 'quota', 403],
      [403, why('rateLimitExceeded'), 'provider', 429],
      [403, why('userRateLimitExceeded'), 'provider', 429],
      [403, why('insufficientFilePermissions'), 'forbidden', 403],
      [403, 'not json {', 'forbidden', 403],
      [
        403,
        `{"error":{"errors":[{"reason":"storageQuotaExceeded"}]},"pad":"${'x'.repeat(2 * MiB)}"}`,
        'forbidden',
        403,
      ],
      [404, { error: { code: 404 } }, 'not_found', 404],
      [400, { error: { code: 400 } }, 'provider', 400],
      [500, '<html>oops</html>', 'provider', 500],
    ]
    for (const [status, body, reason, mapped] of cases) {
      aboutAnswers((_n, res) => send(res, status, body))
      const e = await drive({ folderId: root.id, retries: 0 })
        .a.authCheck(signal)
        .catch((x: unknown) => x)
      expect(e, `${status} ${String(body).slice(0, 40)}`).toMatchObject({ reason, extra: { status: mapped } })
    }
  })

  it('honours Retry-After, caps it at 60 s and reads an HTTP date against the adapter clock', async () => {
    const { root } = layout()
    const calls = aboutAnswers((n, res) =>
      n === 0
        ? send(res, 429, { error: { code: 429 } }, { 'retry-after': '0' })
        : send(res, 200, { user: { emailAddress: 'ops@example.com' } }),
    )
    expect(await drive({ folderId: root.id }).a.authCheck(signal)).toEqual({ account: 'ops@example.com' })
    expect(calls()).toBe(2)

    const T = Date.UTC(2026, 9, 3, 12)
    const cases: Array<[string, number | undefined]> = [
      ['600', 60_000],
      ['5', 5_000],
      [new Date(T + 5_000).toUTCString(), 5_000],
      [new Date(T + 3_600_000).toUTCString(), 60_000],
      [new Date(T - 5_000).toUTCString(), 0],
      ['soon', undefined],
    ]
    for (const [header, ms] of cases) {
      aboutAnswers((_n, res) => send(res, 503, {}, { 'retry-after': header }))
      const e = (await drive({ folderId: root.id, retries: 0, now: () => T })
        .a.authCheck(signal)
        .catch((x: unknown) => x)) as DestinationError
      expect(e.extra.status, header).toBe(503)
      expect(e.extra.retryAfterMs, header).toBe(ms)
    }
  })

  it('refuses a folder search answer larger than 1 MiB and creates nothing', async () => {
    override = (req, res, url) => {
      if (!isListing(req, url)) return false
      send(res, 200, `{"files":[],"pad":"${'x'.repeat(2 * MiB)}"}`)
      return true
    }
    const { a, saved } = drive()
    await expect(a.authCheck(signal)).rejects.toMatchObject({ reason: 'too_large' })
    expect(saved).toEqual([])
    expect(seen.some((s) => s.method === 'POST')).toBe(false)
  })

  it('refuses a folder creation answer that holds no id', async () => {
    override = (req, res, url) => {
      if (req.method !== 'POST' || url.pathname !== '/drive/v3/files') return false
      send(res, 200, 'garbage, not JSON')
      return true
    }
    const { a, saved } = drive()
    await expect(a.authCheck(signal)).rejects.toBeInstanceOf(DestinationError)
    expect(saved).not.toContain('undefined')
  })

  it('does not follow a redirect from the Drive API', async () => {
    override = (_req, res, url) => {
      if (url.pathname !== '/drive/v3/about') return false
      send(res, 307, undefined, { location: `${evil.url}/drive/v3/about` })
      return true
    }
    const { root } = layout()
    await expect(drive({ folderId: root.id }).a.authCheck(signal)).rejects.toMatchObject({
      reason: 'redirect',
    })
    expect(evilHits).toEqual([])
  })

  it('abandons a session on Drive only, tolerating one already gone', async () => {
    const { a } = drive({ retries: 0 })
    let status = 499
    override = (req, res, url) => {
      if (req.method !== 'DELETE' || url.pathname !== '/upload/drive/v3/files') return false
      send(res, status)
      return true
    }
    for (status of [204, 404, 410, 499])
      await a.abandon({ key, session: sessionUrl('s-1'), offset: 0 }, signal)
    expect(seen.filter((s) => s.method === 'DELETE')).toHaveLength(4)
    status = 500
    await expect(a.abandon({ key, session: sessionUrl('s-1'), offset: 0 }, signal)).rejects.toMatchObject({
      reason: 'provider',
      extra: { status: 500 },
    })
    seen.length = 0
    await a.abandon({ key, session: sessionUrl('s-1', evil.url), offset: 0 }, signal)
    await a.abandon({ key, session: 'javascript:alert(1)', offset: 0 }, signal)
    await a.abandon({ key, session: 42 }, signal)
    expect(seen).toEqual([])
    expect(evilHits).toEqual([])
  })

  it('points the connection checks at the API host with its CA', () => {
    const { a } = drive()
    expect(a.endpoint()!.origin).toBe(new URL(g.url).origin)
    expect(a.caPem()).toBe(g.caPem)
    expect(a.readBack).toBe(false)
  })
})

describe('Google sign-in against a misbehaving Google', () => {
  const answer =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (_q: IncomingMessage, res: ServerResponse) =>
      send(res, status, body, headers)

  it('starts a device flow with the RFC 8628 field names and Google’s defaults', async () => {
    script = answer(200, {
      device_code: 'dc-9',
      user_code: 'WXYZ-1234',
      verification_uri: 'https://www.google.com/device',
      expires_in: 1800,
    })
    expect(await startDeviceFlow(egress, oauthHosts, 'client-1', signal)).toEqual({
      deviceCode: 'dc-9',
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://www.google.com/device',
      expiresIn: 1800,
      interval: 5,
    })
    const hit = oauthHits[0]!
    expect(hit.path).toBe('/device/code')
    expect(hit.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(hit.body))).toEqual({
      client_id: 'client-1',
      scope: 'https://www.googleapis.com/auth/drive.file',
    })
  })

  it('refuses a device flow start Google did not grant', async () => {
    const cases: Array<[number, unknown, string, RegExp]> = [
      [400, { error: 'invalid_scope' }, 'provider', /invalid_scope/],
      [500, '<html>down</html>', 'provider', /500/],
      [200, { user_code: 'NO-DEVICE-CODE' }, 'provider', /200/],
      [200, { device_code: 42, user_code: 'X' }, 'provider', /200/],
      [200, 'not json', 'provider', /200/],
      [400, { error: 'invalid_client' }, 'auth', /OAuth client/],
      // Review 2026-10-13 (web): the page links to it — only an https address is.
      [
        200,
        { device_code: 'dc', user_code: 'X', verification_url: 'javascript:alert(1)' },
        'provider',
        /no https sign-in address/,
      ],
      [
        200,
        { device_code: 'dc', user_code: 'X', verification_url: 'http://www.google.com/device' },
        'provider',
        /no https sign-in address/,
      ],
      [200, { device_code: 'dc', user_code: 'X' }, 'provider', /no https sign-in address/],
    ]
    for (const [status, body, reason, msg] of cases) {
      script = answer(status, body)
      const e = (await startDeviceFlow(egress, oauthHosts, 'client-1', signal).catch(
        (x: unknown) => x,
      )) as DestinationError
      expect(e, JSON.stringify(body)).toBeInstanceOf(DestinationError)
      expect(e.reason).toBe(reason)
      expect(e.message).toMatch(msg)
    }
  })

  it('accepts an approval only with both tokens, and refuses answers it does not know', async () => {
    const input = { clientId: 'client-1', clientSecret: 'secret-1', deviceCode: 'dc-1' }
    script = answer(200, { access_token: 'ya29.x', refresh_token: '1//r' })
    expect(await pollDeviceFlow(egress, oauthHosts, input, signal)).toEqual({
      state: 'approved',
      accessToken: 'ya29.x',
      refreshToken: '1//r',
      expiresIn: 3600,
    })
    expect(Object.fromEntries(new URLSearchParams(oauthHits[0]!.body))).toEqual({
      client_id: 'client-1',
      client_secret: 'secret-1',
      device_code: 'dc-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    for (const body of [
      { access_token: 'ya29.x' },
      { access_token: 'ya29.x', refresh_token: 7 },
      { error: 'invalid_grant' },
      { error: 'something_new' },
      'not json',
      {},
    ]) {
      script = answer(200, body)
      await expect(
        pollDeviceFlow(egress, oauthHosts, input, signal),
        JSON.stringify(body),
      ).rejects.toMatchObject({
        reason: 'provider',
      })
    }
    script = answer(401, { error: 'invalid_client' })
    await expect(pollDeviceFlow(egress, oauthHosts, input, signal)).rejects.toMatchObject({ reason: 'auth' })
  })

  it('caches an access token until a minute before it expires', async () => {
    let t = 0
    let n = 0
    script = (_q, res) => send(res, 200, { access_token: `ya29.t${++n}`, expires_in: 120 })
    const tokens = new GoogleTokens({
      egress,
      hosts: oauthHosts,
      source: { kind: 'oauth', clientId: 'c', clientSecret: 's', refreshToken: 'r' },
      now: () => t,
    })
    expect(await tokens.token(signal)).toBe('ya29.t1')
    t = 59_999
    expect(await tokens.token(signal)).toBe('ya29.t1')
    t = 60_000
    expect(await tokens.token(signal)).toBe('ya29.t2')
    expect(Object.fromEntries(new URLSearchParams(oauthHits[0]!.body))).toEqual({
      client_id: 'c',
      client_secret: 's',
      refresh_token: 'r',
      grant_type: 'refresh_token',
    })
    // Without expires_in, Google's one hour.
    script = (_q, res) => send(res, 200, { access_token: `ya29.t${++n}` })
    tokens.invalidate()
    expect(await tokens.token(signal)).toBe('ya29.t3')
    t = 60_000 + 3_539_999
    expect(await tokens.token(signal)).toBe('ya29.t3')
    t = 60_000 + 3_540_000
    expect(await tokens.token(signal)).toBe('ya29.t4')
  })

  it('tells reconnect, wrong credentials and a broken answer apart', async () => {
    const oauthSource = { kind: 'oauth' as const, clientId: 'c', clientSecret: 's', refreshToken: 'r' }
    const saKey = parseServiceAccountKey(JSON.stringify({ type: 'service_account', ...g.serviceKey }))
    const cases: Array<[unknown, 'oauth' | 'sa', string]> = [
      [{ error: 'invalid_grant' }, 'oauth', 'reconnect'],
      [{ error: 'invalid_grant' }, 'sa', 'auth'],
      [{ error: 'invalid_client' }, 'oauth', 'auth'],
      [{ error: 'invalid_client' }, 'sa', 'auth'],
      [{ error: 'temporarily_unavailable' }, 'oauth', 'provider'],
      [{ access_token: 12345 }, 'oauth', 'provider'],
      ['not json', 'sa', 'provider'],
    ]
    for (const [body, kind, reason] of cases) {
      script = answer(400, body)
      const tokens = new GoogleTokens({
        egress,
        hosts: oauthHosts,
        source: kind === 'oauth' ? oauthSource : { kind: 'serviceAccount', key: saKey },
        now: () => Date.now(),
      })
      await expect(tokens.token(signal), `${kind} ${JSON.stringify(body)}`).rejects.toMatchObject({ reason })
    }
  })

  it('a service account signed with another key is refused as wrong credentials', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const forged = {
      ...g.serviceKey,
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
    const tokens = new GoogleTokens({
      egress,
      hosts: g.hosts,
      source: { kind: 'serviceAccount', key: forged },
      now: () => Date.now(),
    })
    await expect(tokens.token(signal)).rejects.toMatchObject({ reason: 'auth' })
  })

  it('does not follow a redirect from the token endpoint, nor read an answer over 1 MiB', async () => {
    script = answer(302, undefined, { location: `${evil.url}/token` })
    const tokens = new GoogleTokens({
      egress,
      hosts: oauthHosts,
      source: { kind: 'oauth', clientId: 'c', clientSecret: 's', refreshToken: '1//secret' },
      now: () => Date.now(),
    })
    await expect(tokens.token(signal)).rejects.toMatchObject({ reason: 'redirect' })
    expect(evilHits).toEqual([])
    script = answer(200, `{"access_token":"ya29.big","pad":"${'x'.repeat(2 * MiB)}"}`)
    await expect(tokens.token(signal)).rejects.toMatchObject({ reason: 'too_large' })
  })
})

describe('Device flows kept on the server', () => {
  const base0 = {
    clientId: 'c',
    clientSecret: 's',
    deviceCode: 'd',
    userCode: 'U',
    verificationUrl: 'https://www.google.com/device',
    interval: 5,
  }

  it('caps a flow at fifteen minutes whatever Google says, and forgets it after', () => {
    let now = 1_000
    const flows = new DeviceFlows(() => now)
    const f = flows.add('admin-1', { ...base0, expiresAt: now + 86_400_000 })
    expect(f).toMatchObject({ state: 'pending', nextPollAt: 1_000, expiresAt: 1_000 + 900_000 })
    now = 1_000 + 899_999
    expect(flows.get('admin-1', f.id)).toBe(f)
    now = 1_000 + 900_000
    expect(flows.get('admin-1', f.id)).toBeUndefined()
  })

  it('hands over only an approved flow with a refresh token, only to its administrator', () => {
    const flows = new DeviceFlows(() => 0, 2)
    const f = flows.add('admin-1', { ...base0, expiresAt: 60_000 })
    f.state = 'approved'
    expect(() => flows.take('admin-1', f.id)).toThrow(/approved/)
    f.refreshToken = 'rt'
    expect(() => flows.take('admin-2', f.id)).toThrow(/approved/)
    expect(flows.take('admin-1', f.id).refreshToken).toBe('rt')
    flows.add('admin-1', { ...base0, expiresAt: 60_000 })
    flows.add('admin-2', { ...base0, expiresAt: 60_000 })
    expect(() => flows.add('admin-3', { ...base0, expiresAt: 60_000 })).toThrow()
  })
})
