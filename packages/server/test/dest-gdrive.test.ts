import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { GdriveConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { GoogleTokens } from '../src/backup/destinations/google-auth'
import { createDriveAdapter, escapeQuery } from '../src/backup/destinations/gdrive'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { installDrive, startFakeGoogle, type FakeGoogle } from './support/fake-google'

let g: FakeGoogle
let dir: string
const MiB = 1024 * 1024
const signal = new AbortController().signal
const egress = createEgress({ networks: ['127.0.0.1/32'] })
beforeAll(async () => {
  g = await startFakeGoogle()
  installDrive(g)
  dir = mkdtempSync(join(tmpdir(), 'mm-drive-'))
})
afterAll(async () => {
  await g?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  g.files.clear()
  g.sessions.clear()
  g.knobs.checksum = 'sha256'
  g.knobs.sessionOrigin = null
})
let folderId: string | null = null
function drive(over: Record<string, unknown> = {}) {
  const tokens = new GoogleTokens({
    egress,
    hosts: g.hosts,
    source: {
      kind: 'oauth',
      clientId: 'cid-00000001',
      clientSecret: 'client-secret-1',
      refreshToken: '1//refresh-1',
    },
    now: () => Date.now(),
  })
  return createDriveAdapter({
    egress,
    hosts: g.hosts,
    tokens,
    config: GdriveConfigSchema.parse({ auth: 'oauth', clientId: 'cid-00000001', ...over }),
    account: null,
    folderId,
    saveFolderId: (id) => (folderId = id),
    partBytes: 16 * MiB,
    now: () => Date.now(),
  })
}
function local(size: number) {
  const body = Buffer.alloc(size, 9)
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
const key = remoteKeyFor('', 'mmbak', '7c9e6679-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
const io = (saved: Array<ResumeState | null> = []) => ({
  progress: () => undefined,
  saveResume: (s: ResumeState | null) => saved.push(s && structuredClone(s)),
})

describe('Google Drive destination (phase 3d-3b spec §2.4)', () => {
  it('finds or creates its folder, names the account, uploads in a session and verifies', async () => {
    folderId = null
    const a = drive()
    expect(await a.authCheck(signal)).toEqual({ account: 'ops@example.com' })
    expect(folderId).toMatch(/^f-/)
    const { body, file } = local(40 * MiB)
    const out = await a.put(key, file, null, io(), signal)
    expect(out.ref).toMatch(/^f-/)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
    expect(await a.stat(key, signal)).toMatchObject({ size: 40 * MiB, sha256: file.sha256 })
    expect((await buffer(await a.get(key, 10, signal))).length).toBe(40 * MiB - 10)
    await a.putSmall(`${key}.json`, Buffer.from('{"v":1}'), signal)
    expect((await a.getSmall(`${key}.json`, 1024, signal))!.toString()).toBe('{"v":1}')
    expect((await a.list(null, signal)).items.map((i) => i.key)).toEqual([key])
    await a.remove(key, signal)
    expect(await a.stat(key, signal)).toBeNull()
  })

  it('resumes a Drive session from its range', async () => {
    const a = drive()
    const { body, file } = local(40 * MiB)
    const ctl = new AbortController()
    const saved: Array<ResumeState | null> = []
    let puts = 0
    const stopping = {
      progress: () => undefined,
      saveResume: (s: ResumeState | null) => {
        saved.push(s && structuredClone(s))
        if (s && typeof s.offset === 'number' && s.offset > 0 && ++puts === 1) ctl.abort()
      },
    }
    await expect(a.put(key, file, null, stopping, ctl.signal)).rejects.toThrow()
    const resume = saved.filter(Boolean).at(-1)!
    const out = await a.put(key, file, resume, io(), signal)
    expect(g.files.get(out.ref!)!.body.equals(body)).toBe(true)
  })

  it('falls back to MD5, and refuses a checksum that differs', async () => {
    const a = drive()
    g.knobs.checksum = 'md5'
    await a.put(key, local(1000).file, null, io(), signal)
    g.files.clear()
    g.knobs.checksum = 'wrong'
    await expect(a.put(key, local(1000).file, null, io(), signal)).rejects.toMatchObject({ reason: 'verify' })
  })

  it('refuses an upload session on another host (D5)', async () => {
    const a = drive()
    g.knobs.sessionOrigin = 'https://evil.example'
    await expect(a.put(key, local(1000).file, null, io(), signal)).rejects.toMatchObject({
      reason: 'provider',
    })
  })

  it('escapes names in queries', () => {
    expect(escapeQuery("it's\\x")).toBe("it\\'s\\\\x")
  })
})
