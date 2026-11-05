// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { DeviceFlowStartSchema, S3ConfigSchema, WebdavConfigSchema } from '../src/index'

const s3 = { preset: 'minio', region: 'us-east-1', bucket: 'acme-backups' }
const dav = { preset: 'nextcloud', username: 'ops' }
const issues = (r: {
  success: boolean
  error?: { issues: Array<{ message: string; path: PropertyKey[] }> }
}) => (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`)

describe('destination addresses (phase 3d-3b final review B27)', () => {
  it('refuses a query or a fragment in a WebDAV address, and says so', () => {
    const url = (u: string) => WebdavConfigSchema.safeParse({ ...dav, url: u })
    expect(url('https://cloud.example.com/remote.php/dav/files/ops').success).toBe(true)
    expect(issues(url('https://cloud.example.com/dav?x=1'))).toEqual([
      'url: The address cannot have a query (?…) or a fragment (#…)',
    ])
    expect(issues(url('https://cloud.example.com/dav#top'))).toEqual([
      'url: The address cannot have a query (?…) or a fragment (#…)',
    ])
    // An empty "?" or "#" is still one.
    expect(url('https://cloud.example.com/dav?').success).toBe(false)
    expect(url('https://cloud.example.com/dav#').success).toBe(false)
  })

  it('takes an S3 endpoint as a scheme, a host and a port only', () => {
    const endpoint = (e: string) => S3ConfigSchema.safeParse({ ...s3, endpoint: e })
    for (const fine of ['https://minio.example.com', 'https://minio.example.com/', 'http://10.0.0.5:9000'])
      expect(endpoint(fine).success, fine).toBe(true)
    expect(issues(endpoint('https://s3.example.com/bucket'))).toEqual([
      'endpoint: The endpoint is the server only: put the bucket and the prefix in their own fields',
    ])
    expect(issues(endpoint('https://s3.example.com?x-id=1'))).toEqual([
      'endpoint: The address cannot have a query (?…) or a fragment (#…)',
    ])
    expect(endpoint('https://s3.example.com/#frag').success).toBe(false)
  })
})

describe('starting a Google sign-in (final review B31)', () => {
  it('takes the client secret, or the saved Drive destination whose stored secret is used, never both', () => {
    const clientId = 'client-id-0001.apps.googleusercontent.com'
    const destinationId = '0e3f3d4a-2b1c-4d5e-8f90-a1b2c3d4e5f6'
    expect(DeviceFlowStartSchema.safeParse({ clientId, clientSecret: 's' }).success).toBe(true)
    expect(DeviceFlowStartSchema.safeParse({ clientId, destinationId }).success).toBe(true)
    expect(DeviceFlowStartSchema.safeParse({ clientId, clientSecret: 's', destinationId }).success).toBe(
      false,
    )
    expect(DeviceFlowStartSchema.safeParse({ clientId }).success).toBe(false)
    expect(DeviceFlowStartSchema.safeParse({ clientId, destinationId: 'not-a-uuid' }).success).toBe(false)
  })
})
