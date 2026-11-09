// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { BackupKeyView, ScheduleRunView, ScheduleView } from '@mongo-manager/shared'

export const SCHEDULE = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 's1',
  name: 'Nightly shop',
  owner: { id: 'u1', username: 'ada' },
  mine: true,
  connectionId: 'c1',
  connectionName: 'Production',
  dump: {
    scope: { kind: 'database', db: 'shop', views: true },
    engine: 'builtin',
    indexes: true,
    options: true,
    anonymous: false,
  },
  format: 'mmbak',
  key: { id: 'k1', name: 'Key 1', fingerprint: 'K-1a2b3c4d', state: 'active' },
  cadence: { kind: 'daily', times: ['02:00'] },
  timeZone: 'Europe/Berlin',
  destinations: [{ id: 'd1', name: 'Offsite', coldStorage: false }],
  keepOnServer: false,
  retention: { last: 7, daily: 14, weekly: 8, monthly: 12 },
  drill: null,
  state: 'active',
  pause: null,
  nextRunAt: Date.now() + 3 * 3_600_000,
  lastRuns: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

export const RUN = (over: Partial<ScheduleRunView> = {}): ScheduleRunView => ({
  id: 'r1',
  dueAt: Date.UTC(2026, 9, 4, 0),
  kind: 'scheduled',
  startedAt: Date.UTC(2026, 9, 4, 0),
  finishedAt: Date.UTC(2026, 9, 4, 0, 2),
  outcome: 'succeeded',
  reason: null,
  message: null,
  backupId: 'b1',
  dumpJobId: 'j1',
  sendJobId: 'j2',
  size: 2_048_000,
  copies: [{ destinationId: 'd1', name: 'Offsite', state: 'complete', reason: null }],
  removals: [],
  missed: null,
  missedMore: false,
  keyFingerprint: 'K-1a2b3c4d',
  drill: null,
  ...over,
})

export const KEY = (over: Partial<BackupKeyView> = {}): BackupKeyView => ({
  id: 'k1',
  name: 'Key 1',
  fingerprint: 'K-1a2b3c4d',
  state: 'active',
  createdAt: Date.UTC(2026, 9, 1),
  confirmedAt: Date.UTC(2026, 9, 1),
  retiredAt: null,
  uses: { schedules: 1, backups: 4 },
  ...over,
})

/** A recovery kit as the server writes it (its key line is all a parser needs). */
export const KIT = [
  'Mongo Manager — backup key recovery kit',
  '',
  'Fingerprint:  K-1a2b3c4d',
  '',
  'MMKEY1-0A1B-2C3D-4E5F-6G7H-8J9K-0M1N-2P3Q-4R5S-6T7V-8W9X-0Y1Z-2A3B-4C00-7QKX',
  '',
].join('\n')
