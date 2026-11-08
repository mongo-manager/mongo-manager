// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  DestinationSummary,
  DestinationView,
  DeviceFlowView,
  DevicePollView,
  JobView,
  RemoteBackupPage,
  TestStep,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** Phase 3d-3b: backup destinations, their remote backups, sends and fetches. */
export const destinationKeys = {
  all: ['destinations'] as const,
  mine: ['destinations', 'mine'] as const,
  admin: ['destinations', 'admin'] as const,
  remote: (id: string) => ['destinations', 'remote', id] as const,
}
export type TestResult = { steps: TestStep[]; account?: string }

export const destinationsApi = {
  mine: () => api.get<DestinationSummary[]>('backup-destinations'),
  all: () => api.get<DestinationView[]>('backup-destinations/all'),
  create: (body: object) => api.post<DestinationView>('backup-destinations', body),
  update: (id: string, body: object) => api.patch<DestinationView>(path`backup-destinations/${id}`, body),
  remove: (id: string) => api.delete<void>(path`backup-destinations/${id}`),
  test: (body: object, init?: { signal?: AbortSignal }) =>
    api.post<TestResult>('backup-destinations/test', body, init),
  /**
   * Phase 3d-3b final review (cross-area contract): with no body the stored destination is tested and
   * its status recorded; with the editor's PATCH body the server merges it over the stored config and
   * secrets, tests that, and records nothing.
   */
  testSaved: (id: string, patch?: object, init?: { signal?: AbortSignal }) =>
    api.post<TestResult>(path`backup-destinations/${id}/test`, patch, init),
  grants: (id: string, grants: Array<{ userId: string; level: string }>) =>
    api.put<DestinationView['grants']>(path`backup-destinations/${id}/grants`, { grants }),
  /** A new client secret, or a saved destination whose stored secret the server uses (it never comes back). */
  startDevice: (body: { clientId: string } & ({ clientSecret: string } | { destinationId: string })) =>
    api.post<DeviceFlowView>('backup-destinations/google/device', body),
  pollDevice: (flowId: string) => api.get<DevicePollView>(path`backup-destinations/google/device/${flowId}`),
  remote: (id: string, cursor?: string | null) =>
    api.get<RemoteBackupPage>(
      cursor
        ? path`backup-destinations/${id}/backups?cursor=${cursor}`
        : path`backup-destinations/${id}/backups`,
    ),
  /** `verified` false: a file without a manifest, checked against nothing before it is restored. */
  fetch: (id: string, body: { connectionId: string; key: string }) =>
    api.post<{ uploadId: string; job: JobView; verified?: boolean }>(
      path`backup-destinations/${id}/backups/fetch`,
      body,
    ),
  /** W4.5: thaw an archived copy for some days, at a speed. */
  thaw: (id: string, body: { key: string; days: number; tier: 'Expedited' | 'Standard' | 'Bulk' }) =>
    api.post<{ state: 'none' | 'thawing' | 'thawed' }>(path`backup-destinations/${id}/backups/thaw`, body),
  removeRemote: (id: string, copyId: string, init?: { keepalive?: boolean }) =>
    api.delete<void>(path`backup-destinations/${id}/backups/${copyId}`, undefined, init),
  send: (backupId: string, body: { destinationIds: string[]; deleteLocal: boolean }) =>
    api.post<{ job: JobView }>(path`backups/${backupId}/send`, body),
  retryCopy: (copyId: string) => api.post<{ job: JobView }>(path`backup-copies/${copyId}/retry`),
  discardCopy: (copyId: string) => api.delete<void>(path`backup-copies/${copyId}`),
}
