// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type {
  DrillLeftovers,
  BackupUploadView,
  BackupView,
  DumpPlan,
  InspectResponse,
  JobView,
  RestorePlan,
  ToolsAvailability,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** Phase 3d-3a: backups, restore uploads and plans. */
export const backupKeys = {
  all: ['backups'] as const,
  list: (connectionId?: string) => ['backups', 'list', connectionId ?? '*'] as const,
  usage: ['backups', 'usage'] as const,
  tools: (connectionId: string) => ['backups', 'tools', connectionId] as const,
}

export interface BackupUsage {
  used: number
  quota: number
  ttlHours: number
  chunkMb: number
}

export const backupApi = {
  tools: (c: string) => api.get<ToolsAvailability>(path`connections/${c}/backup/tools`),
  /** W4 re-review (minor): a connection's leftover drill scratch databases (its admins only). */
  drillLeftovers: (c: string) => api.get<DrillLeftovers>(path`connections/${c}/backup/drill-leftovers`),
  dropDrillLeftover: (c: string, name: string) =>
    api.post<{ dropped: string }>(path`connections/${c}/backup/drill-leftovers/drop`, {
      name,
      confirm: name,
    }),
  /**
   * `asScheduled`: as a schedule runs it, on its own — where the caller's view of the data (local
   * mode's hiding, a "hide from me") masks nothing it writes (personal-data rework, second review A).
   */
  dumpPlan: (c: string, body: object, init?: { signal?: AbortSignal; asScheduled?: boolean }) =>
    api.post<DumpPlan>(
      `${path`connections/${c}/backup/plan`}${init?.asScheduled ? '?asScheduled=1' : ''}`,
      body,
      init?.signal ? { signal: init.signal } : undefined,
    ),
  startDump: (c: string, body: object) => api.post<{ job: JobView }>(path`connections/${c}/backup`, body),
  list: (connectionId?: string) =>
    api.get<BackupView[]>(connectionId ? path`backups?connectionId=${connectionId}` : 'backups'),
  usage: () => api.get<BackupUsage>('backups/usage'),
  remove: (id: string, init?: { keepalive?: boolean }) =>
    api.delete<void>(path`backups/${id}`, undefined, init),
  /** A plain link: the browser downloads with the session cookie; the server sends attachment headers. */
  downloadUrl: (id: string) => new URL(path`backups/${id}/download`, new URL('api/', document.baseURI)).href,
  createUpload: (body: { name: string; size: number }) => api.post<BackupUploadView>('backups/uploads', body),
  uploadPart: (id: string, offset: number, part: Blob, init?: { signal?: AbortSignal }) =>
    api.putBytes<{ received: number; complete: boolean }>(
      path`backups/uploads/${id}?offset=${offset}`,
      part,
      init,
    ),
  uploadStatus: (id: string) => api.get<BackupUploadView>(path`backups/uploads/${id}`),
  discardUpload: (id: string) => api.delete<void>(path`backups/uploads/${id}`),
  inspect: (body: object, init?: { signal?: AbortSignal }) =>
    api.post<InspectResponse>('backups/inspect', body, init),
  restorePlan: (c: string, body: object, init?: { signal?: AbortSignal }) =>
    api.post<RestorePlan>(path`connections/${c}/restore/plan`, body, init),
  startRestore: (c: string, body: object) => api.post<{ job: JobView }>(path`connections/${c}/restore`, body),
}
