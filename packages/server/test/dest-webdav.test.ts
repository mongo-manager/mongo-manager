// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { WebdavConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createWebdavAdapter } from '../src/backup/destinations/webdav'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { startFakeWebdav } from './support/fake-webdav'
import { slow } from './support/slowness'

type Fake = Awaited<ReturnType<typeof startFakeWebdav>>
let generic: Fake
let cloud: Fake
let noRange: Fake
let dir: string
const MiB = 1024 * 1024
const signal = new AbortController().signal
const egress = createEgress({ networks: ['127.0.0.1/32'] })
beforeAll(async () => {
  generic = await startFakeWebdav({ user: 'ops', password: 'pw-generic' })
  cloud = await startFakeWebdav({ user: 'ops', password: 'app-password', nextcloud: true })
  noRange = await startFakeWebdav({ user: 'ops', password: 'pw', ignoreRange: true })
  dir = mkdtempSync(join(tmpdir(), 'mm-dav-'))
})
afterAll(async () => {
  await Promise.all([generic, cloud, noRange].map((f) => f?.close()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function local(size: number) {
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i++) body[i] = (i * 7) % 256
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
const make = (f: Fake, over: Record<string, unknown>, password: string) =>
  createWebdavAdapter({
    egress,
    config: WebdavConfigSchema.parse({
      url: f.url.replace(/\/$/, ''),
      folder: 'Backups/Mongo',
      username: 'ops',
      caPem: f.caPem,
      ...over,
    }),
    secrets: { password },
    partBytes: 16 * MiB,
    now: () => Date.now(),
  })
const key = remoteKeyFor('', 'gzip', '7c9e6679-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
const io = (saved: Array<ResumeState | null> = []) => ({
  progress: () => undefined,
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})

describe('WebDAV destination (phase 3d-3b spec §2.5)', () => {
  it('creates folders, uploads, stats, reads from an offset, lists and deletes (generic)', async () => {
    const a = make(generic, { preset: 'generic' }, 'pw-generic')
    await a.authCheck(signal)
    const { body, file } = local(5000)
    await a.put(key, file, null, io(), signal)
    expect(generic.files.get(`dav/Backups/Mongo/${key}`)!.equals(body)).toBe(true)
    expect(await a.stat(key, signal)).toMatchObject({ size: 5000 })
    expect((await buffer(await a.get(key, 100, signal))).equals(body.subarray(100))).toBe(true)
    await a.putSmall(`${key}.json`, Buffer.from('{}'), signal)
    expect((await a.list(null, signal)).items.map((i) => i.key)).toEqual([key])
    await a.remove(key, signal)
    expect(await a.stat(key, signal)).toBeNull()
  })

  it('refuses a wrong password', async () => {
    await expect(make(generic, { preset: 'generic' }, 'wrong').authCheck(signal)).rejects.toMatchObject({
      reason: 'auth',
    })
  })

  it('skips the bytes it holds when the server ignores Range', async () => {
    const a = make(noRange, { preset: 'generic' }, 'pw')
    const { body, file } = local(3000)
    await a.put(key, file, null, io(), signal)
    expect((await buffer(await a.get(key, 1000, signal))).equals(body.subarray(1000))).toBe(true)
  })

  it('uploads to Nextcloud in chunks and assembles them', async () => {
    const a = make(cloud, { preset: 'nextcloud', url: cloud.root.replace(/\/$/, '') }, 'app-password')
    await a.authCheck(signal)
    const { body, file } = local(40 * MiB)
    await a.put(key, file, null, io(), signal)
    expect(cloud.files.get(`${cloud.filesRoot}Backups/Mongo/${key}`)!.equals(body)).toBe(true)
    expect(cloud.requests.filter((r) => r.startsWith('PUT') && r.includes('/uploads/'))).toHaveLength(3)
  })

  it('resumes a Nextcloud upload from its chunks', async () => {
    const a = make(cloud, { preset: 'nextcloud', url: cloud.root.replace(/\/$/, '') }, 'app-password')
    const { body, file } = local(48 * MiB)
    const ctl = new AbortController()
    const saved: Array<ResumeState | null> = []
    let chunks = 0
    const stopping = {
      progress: () => undefined,
      saveResume: (s: ResumeState | null) => {
        saved.push(s && structuredClone(s))
        if (s && ++chunks === 3) ctl.abort()
      },
    }
    await expect(a.put(key + '.x', file, null, stopping, ctl.signal)).rejects.toThrow()
    const resume = saved.filter(Boolean).at(-1)!
    cloud.requests.length = 0
    await a.put(key + '.x', file, resume, io(), signal)
    expect(cloud.files.get(`${cloud.filesRoot}Backups/Mongo/${key}.x`)!.equals(body)).toBe(true)
    expect(cloud.requests.filter((r) => r.startsWith('PUT') && r.includes('/uploads/'))).toHaveLength(1)
  })
})

// Full server run, 2026-10-20 (review of the stream errors): the local file was piped into the
// counting stream, and .pipe() does not pass an error on. A file that cannot be read (gone before
// its send) was an uncaught error, which ends the server, and the send waited for an end that never
// came. The send fails, with the file's error.
describe('a WebDAV send whose file cannot be read', () => {
  it(
    'fails, generic and Nextcloud alike',
    async () => {
      for (const [f, preset, password] of [
        [generic, 'generic', 'pw-generic'],
        [cloud, 'nextcloud', 'app-password'],
      ] as const) {
        const a = make(f, { preset }, password)
        const { file } = local(1024)
        rmSync(file.path)
        await expect(a.put(`${key}.gone-${preset}`, file, null, io(), signal)).rejects.toMatchObject({
          reason: 'body',
          detail: 'ENOENT',
        })
      }
    },
    slow(20_000),
  )
})
