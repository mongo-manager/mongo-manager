// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3ConfigSchema, WebdavConfigSchema, GdriveConfigSchema } from '@mongo-manager/shared'
import { createEgress } from '../src/net/egress'
import { createS3Adapter } from '../src/backup/destinations/s3'
import { createWebdavAdapter } from '../src/backup/destinations/webdav'
import { createDriveAdapter } from '../src/backup/destinations/gdrive'
import { GOOGLE_HOSTS, GoogleTokens } from '../src/backup/destinations/google-auth'
import { testDestination } from '../src/backup/destinations/registry'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import type { DestinationAdapter } from '../src/backup/destinations/types'
import { isCI } from './support/slowness'

const env = process.env
const egress = createEgress({ networks: [] })
const now = () => Date.now()
async function roundTrip(a: DestinationAdapter, prefix: string) {
  const steps = (await testDestination(a, prefix, { egress, now }, AbortSignal.timeout(60_000))).steps
  expect(
    steps.every((s) => s.ok),
    JSON.stringify(steps),
  ).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'mm-live-'))
  try {
    const body = Buffer.alloc(20 * 1024 * 1024, 3)
    const path = join(dir, 'f')
    writeFileSync(path, body)
    const key = remoteKeyFor(prefix, 'mmbak', randomUUID(), Date.now())
    const file = {
      path,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('hex'),
    }
    await a.put(
      key,
      file,
      null,
      { progress: () => undefined, saveResume: () => undefined },
      AbortSignal.timeout(300_000),
    )
    expect((await a.stat(key, AbortSignal.timeout(60_000)))?.size).toBe(body.length)
    await a.remove(key, AbortSignal.timeout(60_000))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('live providers (phase 3d-3b spec §7; never in CI)', () => {
  it.skipIf(!env.MM_TEST_S3_ENDPOINT || isCI())(
    'S3 — MM_TEST_S3_ENDPOINT, _REGION, _BUCKET, _KEY, _SECRET',
    async () => {
      const config = S3ConfigSchema.parse({
        preset: 'custom',
        endpoint: env.MM_TEST_S3_ENDPOINT,
        region: env.MM_TEST_S3_REGION,
        bucket: env.MM_TEST_S3_BUCKET,
        prefix: 'mm-live',
        pathStyle: env.MM_TEST_S3_PATH_STYLE === '1',
      })
      await roundTrip(
        createS3Adapter({
          egress,
          config,
          secrets: { accessKeyId: env.MM_TEST_S3_KEY!, secretAccessKey: env.MM_TEST_S3_SECRET! },
          partBytes: 16 * 1024 * 1024,
          now,
        }),
        'mm-live',
      )
    },
    600_000,
  )

  it.skipIf(!env.MM_TEST_WEBDAV_URL || isCI())(
    'WebDAV — MM_TEST_WEBDAV_URL, _USER, _PASSWORD, _PRESET',
    async () => {
      const config = WebdavConfigSchema.parse({
        preset: env.MM_TEST_WEBDAV_PRESET ?? 'generic',
        url: env.MM_TEST_WEBDAV_URL,
        username: env.MM_TEST_WEBDAV_USER,
        folder: 'mm-live',
      })
      await roundTrip(
        createWebdavAdapter({
          egress,
          config,
          secrets: { password: env.MM_TEST_WEBDAV_PASSWORD! },
          partBytes: 16 * 1024 * 1024,
          now,
        }),
        '',
      )
    },
    600_000,
  )

  it.skipIf(!env.MM_TEST_GDRIVE_REFRESH_TOKEN || isCI())(
    'Drive — MM_TEST_GDRIVE_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN',
    async () => {
      const tokens = new GoogleTokens({
        egress,
        hosts: GOOGLE_HOSTS,
        source: {
          kind: 'oauth',
          clientId: env.MM_TEST_GDRIVE_CLIENT_ID!,
          clientSecret: env.MM_TEST_GDRIVE_CLIENT_SECRET!,
          refreshToken: env.MM_TEST_GDRIVE_REFRESH_TOKEN!,
        },
        now,
      })
      const config = GdriveConfigSchema.parse({
        auth: 'oauth',
        clientId: env.MM_TEST_GDRIVE_CLIENT_ID,
        folderName: 'Mongo Manager live test',
      })
      await roundTrip(
        createDriveAdapter({
          egress,
          hosts: GOOGLE_HOSTS,
          tokens,
          config,
          account: null,
          folderId: null,
          saveFolderId: () => undefined,
          partBytes: 16 * 1024 * 1024,
          now,
        }),
        '',
      )
    },
    600_000,
  )
})
