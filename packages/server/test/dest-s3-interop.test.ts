// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { S3ConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createS3Adapter } from '../src/backup/destinations/s3'
import { signRequest, EMPTY_SHA256 } from '../src/backup/destinations/s3-sign'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { seaweed } from './support/seaweedfs'
import { slow } from './support/slowness'

let s: Awaited<ReturnType<typeof seaweed>>
let dir: string
beforeAll(async () => {
  s = await seaweed()
  dir = mkdtempSync(join(tmpdir(), 'mm-interop-'))
  if (!s) return
  const url = new URL(`${s.endpoint}/${s.bucket}`)
  const headers = signRequest({
    method: 'PUT',
    url,
    headers: {},
    payloadHash: EMPTY_SHA256,
    region: 'us-east-1',
    now: new Date(),
    credentials: s.credentials,
  })
  await fetch(url, { method: 'PUT', headers })
}, slow(300_000))
afterAll(async () => {
  await s?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('S3 interoperability with SeaweedFS 4.48 (plan ruling 1)', () => {
  it('signs, uploads in parts, verifies, lists, reads back and deletes against a real S3', async (ctx) => {
    if (!s) return ctx.skip()
    // Plain http inside the allowed network: the egress rule for private S3s.
    const egress = createEgress({ networks: ['127.0.0.1/32'] })
    const a = createS3Adapter({
      egress,
      config: S3ConfigSchema.parse({
        preset: 'custom',
        endpoint: s.endpoint,
        region: 'us-east-1',
        bucket: s.bucket,
        prefix: 'ci',
        pathStyle: true,
      }),
      secrets: s.credentials,
      partBytes: 16 * 1024 * 1024,
      now: () => Date.now(),
    })
    const body = Buffer.alloc(40 * 1024 * 1024, 7)
    const path = join(dir, 'big.bin')
    writeFileSync(path, body)
    const key = remoteKeyFor('ci', 'mmbak', '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6', Date.now())
    await a.authCheck(AbortSignal.timeout(30_000))
    await a.put(
      key,
      {
        path,
        size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        md5: createHash('md5').update(body).digest('hex'),
      },
      null,
      { progress: () => undefined, saveResume: () => undefined },
      AbortSignal.timeout(120_000),
    )
    expect((await a.list(null, AbortSignal.timeout(30_000))).items.map((i) => i.key)).toContain(key)
    const tail = await buffer(await a.get(key, body.length - 10, AbortSignal.timeout(30_000)))
    expect(tail.length).toBe(10)
    await a.remove(key, AbortSignal.timeout(30_000))
    expect(await a.stat(key, AbortSignal.timeout(30_000))).toBeNull()
  }, 300_000)
})
