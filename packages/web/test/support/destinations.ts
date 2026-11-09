// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DestinationView } from '@mongo-manager/shared'

export const DEST = (over: Partial<DestinationView> = {}): DestinationView => ({
  id: 'd1',
  name: 'Offsite',
  type: 's3',
  config: {
    preset: 'aws',
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    bucket: 'acme',
    prefix: '',
    pathStyle: false,
    storageClass: 'STANDARD',
    sse: { kind: 'none' },
  },
  secrets: { accessKeyId: true, secretAccessKey: true },
  keyHint: '7KQ2',
  policy: { encryptedOnly: true },
  status: { state: 'ok', checkedAt: Date.now() - 60_000 },
  grants: [{ userId: 'u1', username: 'alice', level: 'send' }],
  usage: { copies: 3, bytes: 3 * 1024 * 1024 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
