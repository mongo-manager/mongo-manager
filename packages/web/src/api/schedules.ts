import type {
  BackupKeyCreated,
  BackupKeyView,
  SchedulePreview,
  ScheduleRunView,
  ScheduleView,
  SchedulesList,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** Phase 3d-3c: scheduled backups and backup keys. */
export const scheduleKeys = {
  all: ['schedules'] as const,
  list: ['schedules', 'list'] as const,
  runs: (id: string) => ['schedules', 'runs', id] as const,
  keys: ['backup-keys'] as const,
}

export const schedulesApi = {
  list: () => api.get<SchedulesList>('backup-schedules'),
  create: (body: object) => api.post<ScheduleView>('backup-schedules', body),
  update: (id: string, body: object) => api.patch<ScheduleView>(path`backup-schedules/${id}`, body),
  remove: (id: string) => api.delete<void>(path`backup-schedules/${id}`),
  pause: (id: string) => api.post<ScheduleView>(path`backup-schedules/${id}/pause`),
  resume: (id: string) => api.post<ScheduleView>(path`backup-schedules/${id}/resume`),
  run: (id: string) => api.post<{ run: ScheduleRunView }>(path`backup-schedules/${id}/run`),
  runs: (id: string) => api.get<ScheduleRunView[]>(path`backup-schedules/${id}/runs`),
  preview: (body: object, init?: { signal?: AbortSignal }) =>
    api.post<SchedulePreview>('backup-schedules/preview', body, init),
}

export const keysApi = {
  list: () => api.get<BackupKeyView[]>('backup-keys'),
  create: (name?: string) => api.post<BackupKeyCreated>('backup-keys', name ? { name } : {}),
  confirm: (id: string, check: string) => api.post<BackupKeyView>(path`backup-keys/${id}/confirm`, { check }),
  retire: (id: string) => api.post<BackupKeyView>(path`backup-keys/${id}/retire`),
  activate: (id: string) => api.post<BackupKeyView>(path`backup-keys/${id}/activate`),
  import: (kit: string, name?: string) =>
    api.post<BackupKeyView>('backup-keys/import', { kit, ...(name ? { name } : {}) }),
  remove: (id: string) => api.delete<void>(path`backup-keys/${id}`),
}
