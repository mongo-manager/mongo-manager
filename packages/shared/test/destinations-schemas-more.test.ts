// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  DestinationInputSchema,
  DeviceFlowStartSchema,
  GdriveConfigSchema,
  GrantsSchema,
  S3ConfigSchema,
  WebdavConfigSchema,
} from '../src/index'

const s3 = {
  preset: 'minio',
  endpoint: 'https://minio.example.com',
  region: 'us-east-1',
  bucket: 'acme-backups',
}
const dav = { preset: 'nextcloud', url: 'https://cloud.example.com', username: 'ops' }
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
const messages = (r: {
  success: boolean
  error?: { issues: Array<{ message: string; path: PropertyKey[] }> }
}) => (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`)

describe('destination schema refinements (phase 3d-3b spec §1.1, §3)', () => {
  it('accepts a CA certificate only as PEM', () => {
    expect(S3ConfigSchema.safeParse({ ...s3, caPem: PEM }).success).toBe(true)
    expect(WebdavConfigSchema.safeParse({ ...dav, caPem: PEM }).success).toBe(true)
    expect(messages(S3ConfigSchema.safeParse({ ...s3, caPem: 'MIIB-not-a-pem' }))).toEqual([
      'caPem: A PEM certificate is expected',
    ])
    expect(messages(WebdavConfigSchema.safeParse({ ...dav, caPem: '-----BEGIN PRIVATE KEY-----' }))).toEqual([
      'caPem: A PEM certificate is expected',
    ])
    expect(S3ConfigSchema.safeParse({ ...s3, caPem: `${PEM}${'x'.repeat(65_536)}` }).success).toBe(false)
  })

  it('refuses addresses that are not http(s) or carry credentials', () => {
    const url = (u: string) => WebdavConfigSchema.safeParse({ ...dav, url: u }).success
    expect(url('https://cloud.example.com/remote.php/dav')).toBe(true)
    expect(url('http://10.0.0.5:8080')).toBe(true)
    expect(url('file:///etc/passwd')).toBe(false)
    expect(url('javascript:alert(1)')).toBe(false)
    expect(url('https://ops@cloud.example.com')).toBe(false)
    expect(url('https://:secret@cloud.example.com')).toBe(false)
  })

  // The server's parseInput relies on safeParse returning an issue; an exception becomes a 500.
  it('answers an address that is not a URL with an issue, never an exception', () => {
    for (const u of ['cloud.example.com', 'not a url', ''])
      expect(() => WebdavConfigSchema.safeParse({ ...dav, url: u }), u).not.toThrow()
    expect(() => S3ConfigSchema.safeParse({ ...s3, endpoint: 'minio.local:9000/x' })).not.toThrow()
  })

  it('keeps prefixes and folders to safe relative segments', () => {
    const folder = (f: string) => WebdavConfigSchema.safeParse({ ...dav, folder: f }).success
    for (const ok of ['', 'Backups', 'mongo/prod', 'a b/c_d-e.f']) expect(folder(ok), ok).toBe(true)
    for (const bad of [
      '/abs',
      'trailing/',
      'a//b',
      '..',
      'a/../b',
      '.',
      ' lead',
      'trail ',
      'a\\b',
      'a/b?c',
      'x'.repeat(129),
    ])
      expect(folder(bad), bad).toBe(false)
    expect(S3ConfigSchema.parse(s3).prefix).toBe('')
    expect(S3ConfigSchema.safeParse({ ...s3, prefix: 'a/%2e%2e' }).success).toBe(false)
  })

  it('asks a service account for its Shared Drive and OAuth for its client id, at the field', () => {
    expect(messages(GdriveConfigSchema.safeParse({ auth: 'serviceAccount' }))).toEqual([
      'sharedDriveId: A service account writes into a Shared Drive: its id is required',
    ])
    expect(messages(GdriveConfigSchema.safeParse({ auth: 'oauth' }))).toEqual([
      'clientId: The OAuth client id is required',
    ])
    expect(
      GdriveConfigSchema.safeParse({ auth: 'oauth', clientId: 'client-id-0001.apps.googleusercontent.com' })
        .success,
    ).toBe(true)
    expect(
      GdriveConfigSchema.safeParse({ auth: 'serviceAccount', sharedDriveId: '0AbCdEfGhIjKlMn' }).success,
    ).toBe(true)
    // A Drive folder name never reaches into a path or a query.
    for (const name of ['a/b', 'a\\b', "it's", 'say "hi"', '   '])
      expect(
        GdriveConfigSchema.safeParse({
          auth: 'serviceAccount',
          sharedDriveId: '0AbCdEfGhIjKlMn',
          folderName: name,
        }).success,
        name,
      ).toBe(false)
    expect(GdriveConfigSchema.safeParse({ auth: 'oauth', clientId: 'id with spaces' }).success).toBe(false)
    expect(DeviceFlowStartSchema.safeParse({ clientId: 'short', clientSecret: 's' }).success).toBe(false)
    expect(DeviceFlowStartSchema.safeParse({ clientId: 'client-id-0001', clientSecret: '' }).success).toBe(
      false,
    )
  })

  it('refuses unknown fields and a device flow id that is not a uuid', () => {
    const input = {
      type: 'gdrive',
      name: 'Drive',
      config: { auth: 'oauth', clientId: 'client-id-0001.apps.googleusercontent.com' },
    }
    expect(
      DestinationInputSchema.safeParse({ ...input, deviceFlowId: '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6' })
        .success,
    ).toBe(true)
    expect(DestinationInputSchema.safeParse({ ...input, deviceFlowId: '../flows/1' }).success).toBe(false)
    expect(
      DestinationInputSchema.safeParse({ ...input, config: { ...input.config, refreshToken: 'stolen' } })
        .success,
    ).toBe(false)
    expect(DestinationInputSchema.safeParse({ ...input, secrets: { refreshToken: 'x' } }).success).toBe(false)
  })

  it('lists each user once in a grant list, at a known level', () => {
    expect(
      GrantsSchema.parse({
        grants: [
          { userId: 'u1', level: 'send' },
          { userId: 'u2', level: 'browse' },
        ],
      }).grants,
    ).toHaveLength(2)
    expect(GrantsSchema.parse({ grants: [] }).grants).toEqual([])
    expect(
      messages(
        GrantsSchema.safeParse({
          grants: [
            { userId: 'u1', level: 'send' },
            { userId: 'u1', level: 'browse' },
          ],
        }),
      ),
    ).toEqual(['grants: A user is listed twice'])
    expect(GrantsSchema.safeParse({ grants: [{ userId: 'u1', level: 'admin' }] }).success).toBe(false)
    expect(GrantsSchema.safeParse({ grants: [{ userId: '', level: 'send' }] }).success).toBe(false)
    expect(
      GrantsSchema.safeParse({
        grants: Array.from({ length: 501 }, (_, i) => ({ userId: `u${i}`, level: 'send' })),
      }).success,
    ).toBe(false)
  })
})
