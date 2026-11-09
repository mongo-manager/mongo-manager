// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  DestinationInputSchema,
  DestinationPatchSchema,
  DumpRequestSchema,
  FetchRequestSchema,
  JOB_KINDS,
  SendRequestSchema,
} from '../src/index'

const s3 = {
  type: 's3',
  name: 'Offsite',
  config: {
    preset: 'aws',
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    bucket: 'acme-backups',
    prefix: 'prod',
    pathStyle: false,
    storageClass: 'STANDARD',
    sse: { kind: 'none' },
  },
  secrets: { accessKeyId: 'AKIAEXAMPLE0001', secretAccessKey: 'secret-secret-secret' },
  policy: { encryptedOnly: true },
}

describe('destination contracts (phase 3d-3b spec §1.1, §4.5)', () => {
  it('accepts each type and defaults encrypted-only to on', () => {
    expect(DestinationInputSchema.parse(s3).policy.encryptedOnly).toBe(true)
    const { policy: _p, ...noPolicy } = s3
    expect(DestinationInputSchema.parse(noPolicy).policy.encryptedOnly).toBe(true)
    expect(
      DestinationInputSchema.parse({ type: 'folder', name: 'Disk', config: { path: '/srv/backups/mm' } })
        .type,
    ).toBe('folder')
    const dav = DestinationInputSchema.parse({
      type: 'webdav',
      name: 'Cloud',
      config: { preset: 'nextcloud', url: 'https://cloud.example.com', folder: 'Backups', username: 'ops' },
      secrets: { password: 'app-password' },
    })
    expect(dav.type === 'webdav' && dav.config.verifyReadBack).toBe(false)
    const drive = DestinationInputSchema.parse({
      type: 'gdrive',
      name: 'Drive',
      config: { auth: 'serviceAccount', sharedDriveId: '0AbCdEfGhIjKlMn' },
      secrets: { serviceAccountKey: '{}' },
    })
    expect(drive.type === 'gdrive' && drive.config.folderName).toBe('Mongo Manager backups')
  })

  it('refuses unsafe names, prefixes and URLs', () => {
    const bad = (patch: object) =>
      DestinationInputSchema.safeParse({ ...s3, config: { ...s3.config, ...patch } }).success
    expect(bad({ prefix: '../etc' })).toBe(false)
    expect(bad({ prefix: 'a/./b' })).toBe(false)
    expect(bad({ bucket: 'Bad_Bucket' })).toBe(false)
    expect(bad({ endpoint: 'ftp://x.example.com' })).toBe(false)
    expect(bad({ endpoint: 'https://user:pass@x.example.com' })).toBe(false)
    expect(DestinationInputSchema.safeParse({ ...s3, name: '' }).success).toBe(false)
    expect(
      DestinationInputSchema.safeParse({
        type: 'gdrive',
        name: 'Drive',
        config: { auth: 'serviceAccount' },
        secrets: { serviceAccountKey: '{}' },
      }).success,
    ).toBe(false)
  })

  it('patches leave secrets out unless replaced', () => {
    expect(DestinationPatchSchema.parse({ name: 'New name' })).toEqual({ name: 'New name' })
    expect(DestinationPatchSchema.safeParse({ secrets: { accessKeyId: '' } }).success).toBe(false)
  })

  it('bounds sends, fetches and dumps with destinations', () => {
    const id = '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'
    expect(SendRequestSchema.parse({ destinationIds: [id] })).toEqual({
      destinationIds: [id],
      deleteLocal: false,
    })
    expect(SendRequestSchema.safeParse({ destinationIds: [] }).success).toBe(false)
    expect(SendRequestSchema.safeParse({ destinationIds: Array(9).fill(id) }).success).toBe(false)
    expect(FetchRequestSchema.safeParse({ connectionId: 'c1', key: 'mongo-manager/2026/10/x' }).success).toBe(
      true,
    )
    const dump = DumpRequestSchema.parse({ scope: { kind: 'database', db: 'shop' } })
    expect(dump).toMatchObject({ destinations: [], deleteLocal: false })
    expect(JOB_KINDS).toContain('backup.send')
    expect(JOB_KINDS).toContain('backup.fetch')
  })
})
