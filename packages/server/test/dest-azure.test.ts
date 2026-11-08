// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { AzureConfigSchema, AzureSecretsSchema, sasFields } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createAzureAdapter } from '../src/backup/destinations/azure'
import { stringToSign } from '../src/backup/destinations/azure-sign'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { ResumeState } from '../src/backup/destinations/types'
import { startFakeAzure, type FakeAzure } from './support/fake-azure'

/** W4 item 5 (completion design §2 W4.5): Azure Blob Storage as a backup destination. */
let az: FakeAzure
let dir: string
const signal = new AbortController().signal
const MiB = 1024 * 1024
beforeAll(async () => {
  az = await startFakeAzure({ pageSize: 2 })
  dir = mkdtempSync(join(tmpdir(), 'mm-azure-'))
})
afterAll(async () => {
  await az?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  az.blobs.clear()
  az.blocks.clear()
  az.requests.length = 0
  az.knobs.failures = []
  az.knobs.corruptBlock = false
})

const egress = createEgress({ networks: ['127.0.0.1/32'] })
function adapter(over: Record<string, unknown> = {}, secrets?: Record<string, string>, partBytes = MiB) {
  const config = AzureConfigSchema.parse({
    account: az.account,
    container: az.containerName,
    prefix: 'prod',
    auth: 'sharedKey',
    endpoint: az.url,
    caPem: az.caPem,
    ...over,
  })
  return createAzureAdapter({
    egress,
    config,
    secrets: secrets ?? (config.auth === 'sas' ? { sasToken: az.sasToken } : { accountKey: az.accountKey }),
    partBytes,
    now: () => Date.now(),
    retries: 0,
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

describe('Azure Blob Storage destination (W4.5)', () => {
  it('signs as Azure documents it (the example of its Shared Key page)', () => {
    const url = new URL(
      'https://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=metadata&timeout=20',
    )
    expect(
      stringToSign(
        'GET',
        url,
        { 'x-ms-date': 'Sun, 11 Oct 2009 21:49:13 GMT', 'x-ms-version': '2009-09-19' },
        'myaccount',
      ),
    ).toBe(
      'GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:Sun, 11 Oct 2009 21:49:13 GMT\nx-ms-version:2009-09-19\n/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20',
    )
  })

  it('signs in with the shared key, and the key never travels', async () => {
    expect(await adapter().authCheck(signal)).toEqual({})
    const sent = JSON.stringify(az.requests)
    expect(sent).not.toContain(az.accountKey)
    expect(az.requests[0]!.headers.authorization).toMatch(/^SharedKey mmaccount:/)
    const wrong = Buffer.alloc(64, 7).toString('base64')
    await expect(adapter({}, { accountKey: wrong }).authCheck(signal)).rejects.toMatchObject({
      reason: 'auth',
    })
  })

  it('signs in with a SAS token appended to each request, and refuses one that would change a request', async () => {
    expect(await adapter({ auth: 'sas' }).authCheck(signal)).toEqual({})
    expect(az.requests[0]!.query).toContain('sig=')
    expect(az.requests[0]!.headers.authorization).toBeUndefined()
    for (const bad of [
      'sv=1&sig=x&comp=list',
      'sv=1&sig=x&restype=service',
      'sp=r&sig=x',
      'sv=1',
      'sv=1&sig=x#y',
      'sv=1&sv=2&sig=x',
    ])
      expect(sasFields(bad), bad).toBeNull()
    expect(AzureSecretsSchema.safeParse({ sasToken: 'sv=1&sig=x&comp=list' }).success).toBe(false)
    expect(sasFields(az.sasToken)).not.toBeNull()
    expect(() => adapter({ auth: 'sas' }, { sasToken: 'sv=1&sig=x&comp=list' })).toThrow(/credentials/)
  })

  it('puts a small backup whole, checked by its MD5, in the chosen tier', async () => {
    const k = key()
    const f = file(200 * 1024)
    const out = await adapter({ accessTier: 'Cool' }).put(k, f.local, null, io(), signal)
    expect(out.checksums).toEqual({ md5: f.local.md5 })
    expect(az.blobs.get(k)).toMatchObject({ tier: 'Cool' })
    expect(az.blobs.get(k)!.body.equals(f.body)).toBe(true)
    const put = az.requests.find((r) => r.method === 'PUT')!
    expect(put.headers['content-md5']).toBe(Buffer.from(f.local.md5, 'hex').toString('base64'))
    expect(await adapter().stat(k, signal)).toEqual({
      size: f.body.length,
      archived: false,
      md5: f.local.md5,
    })
    const tail = await buffer(await adapter().get(k, 1000, signal))
    expect(tail.equals(f.body.subarray(1000))).toBe(true)
  })

  it('sends a large backup in blocks, each with its MD5, and resumes from the blocks Azure holds', async () => {
    const k = key()
    const f = file(Math.floor(3.5 * MiB))
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
            if (++parts === 3) ctl.abort()
          },
          saveResume: (s) => saved.push(s && structuredClone(s)),
        },
        ctl.signal,
      ),
    ).rejects.toBeTruthy()
    expect(az.blocks.get(k)!.size).toBe(2)
    az.requests.length = 0
    await adapter().put(k, f.local, saved.filter(Boolean).at(-1)!, io(), signal)
    expect(az.blobs.get(k)!.body.equals(f.body)).toBe(true)
    // Only the two missing blocks went up again.
    const blocks = az.requests.filter((r) => r.query.includes('comp=block&'))
    expect(blocks).toHaveLength(2)
    expect(blocks.every((r) => typeof r.headers['content-md5'] === 'string')).toBe(true)
  })

  // W4 review I3: blocks Azure holds from another attempt are never committed as this one's.
  it('reuses only its own upload’s blocks, and only when it resumes', async () => {
    const k = key()
    const first = file(Math.floor(3.5 * MiB))
    const ctl = new AbortController()
    let parts = 0
    await expect(
      adapter().put(
        k,
        first.local,
        null,
        {
          progress: () => {
            if (++parts === 3) ctl.abort()
          },
          saveResume: () => undefined,
        },
        ctl.signal,
      ),
    ).rejects.toBeTruthy()
    expect(az.blocks.get(k)!.size).toBe(2)
    // Another backup of the same size, its resume state lost: nothing of the first goes in.
    const second = file(Math.floor(3.5 * MiB))
    second.body.fill(7)
    writeFileSync(second.local.path, second.body)
    az.requests.length = 0
    await adapter().put(k, second.local, null, io(), signal)
    expect(az.blobs.get(k)!.body.equals(second.body)).toBe(true)
    expect(az.requests.filter((r) => r.query.includes('comp=block&'))).toHaveLength(4)
  })

  it('resumes from its own blocks only, whatever another attempt left', async () => {
    const k = key()
    const f = file(Math.floor(3.5 * MiB))
    const stopAfter = async (n: number, resume: ResumeState | null, body = f) => {
      const ctl = new AbortController()
      const saved: Array<ResumeState | null> = []
      let parts = 0
      await expect(
        adapter().put(
          k,
          body.local,
          resume,
          {
            progress: () => {
              if (++parts === n + 1) ctl.abort()
            },
            saveResume: (s) => saved.push(s && structuredClone(s)),
          },
          ctl.signal,
        ),
      ).rejects.toBeTruthy()
      return saved.filter(Boolean).at(-1)!
    }
    const mine = await stopAfter(2, null)
    // Another attempt (another backup) left three blocks of its own.
    const other = file(Math.floor(3.5 * MiB))
    other.body.fill(9)
    writeFileSync(other.local.path, other.body)
    await stopAfter(3, null, other)
    await adapter().put(k, f.local, mine, io(), signal)
    expect(az.blobs.get(k)!.body.equals(f.body)).toBe(true)
  })

  it('stores manifests outside the Archive tier, reports archived blobs and rehydrates them', async () => {
    const k = key()
    const a = adapter({ accessTier: 'Archive' })
    await a.put(k, file(1024).local, null, io(), signal)
    await a.putSmall(`${k}.json`, Buffer.from('{}'), signal)
    expect(az.blobs.get(k)!.tier).toBe('Archive')
    expect(az.blobs.get(`${k}.json`)!.tier).toBe('Hot')
    expect(await a.stat(k, signal)).toMatchObject({ archived: true, thaw: 'none' })
    await expect(a.get(k, 0, signal)).rejects.toMatchObject({ reason: 'archived' })
    expect((await a.list(null, signal)).items).toEqual([expect.objectContaining({ key: k, archived: true })])
    expect(await a.thaw!(k, { days: 1, tier: 'Expedited' }, signal)).toEqual({ state: 'thawing' })
    expect(az.blobs.get(k)!.rehydrating).toBe('High')
    expect(await a.stat(k, signal)).toMatchObject({ archived: true, thaw: 'thawing' })
    await expect(a.thaw!(`${k}.json`, { days: 1, tier: 'Standard' }, signal)).rejects.toMatchObject({
      reason: 'not_archived',
    })
  })

  it('lists only the layout’s blobs over several pages, newest first', async () => {
    const keys = [key(), key(), key()]
    for (const k of keys)
      az.blobs.set(k, {
        body: Buffer.from('x'),
        tier: 'Hot',
        etag: '"1"',
        modified: new Date().toUTCString(),
      })
    az.blobs.set('prod/mongo-manager/../evil', {
      body: Buffer.from('x'),
      tier: 'Hot',
      etag: '"2"',
      modified: '',
    })
    az.blobs.set('prod/other', { body: Buffer.from('x'), tier: 'Hot', etag: '"3"', modified: '' })
    expect((await adapter().list(null, signal)).items.map((i) => i.key)).toEqual([...keys].sort().reverse())
  })

  it('abandons an upload without touching a blob that is there, and says a missing container', async () => {
    const k = key()
    az.blocks.set(k, new Map([['bW0tMDAwMDAx', Buffer.from('x')]]))
    await adapter().abandon({ key: k, blockSize: MiB, count: 2 }, signal)
    expect(az.blocks.has(k)).toBe(false)
    expect(az.blobs.has(k)).toBe(false)
    const kept = key()
    await adapter().put(kept, file(10).local, null, io(), signal)
    await adapter().abandon({ key: kept, blockSize: MiB, count: 2 }, signal)
    expect(az.blobs.get(kept)!.body.length).toBe(10)
    await expect(adapter({ container: 'other-container' }).authCheck(signal)).rejects.toMatchObject({
      reason: 'bucket',
    })
  })

  it('never repeats Azure’s message (it can quote what was signed), and refuses a plain-http endpoint', async () => {
    const e = await adapter({}, { accountKey: Buffer.alloc(64, 1).toString('base64') })
      .authCheck(signal)
      .catch((x: Error) => x)
    expect(String((e as Error).message)).not.toContain('string to sign')
    expect(
      AzureConfigSchema.safeParse({
        account: 'abc',
        container: 'abc',
        auth: 'sas',
        endpoint: 'http://x.example',
      }).success,
    ).toBe(false)
    for (const bad of ['ABC', 'a', 'a-b', 'abc.def', 'x'.repeat(25)])
      expect(AzureConfigSchema.safeParse({ account: bad, container: 'abc', auth: 'sas' }).success, bad).toBe(
        false,
      )
    for (const bad of ['a--b', '-ab', 'ab-', 'AB', 'a'])
      expect(AzureConfigSchema.safeParse({ account: 'abc', container: bad, auth: 'sas' }).success, bad).toBe(
        false,
      )
  })
})
