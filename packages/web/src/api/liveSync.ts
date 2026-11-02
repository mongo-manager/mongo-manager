import type {
  LiveSyncDetail,
  LiveSyncLag,
  LiveSyncPlan,
  LiveSyncView,
  LiveSyncsList,
  LiveSyncVerifySamples,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

const apiBase = () => new URL('api/', document.baseURI)

/** Phase 3e-2: live syncs between connections. */
export const liveSyncKeys = {
  all: ['live-syncs'] as const,
  list: ['live-syncs', 'list'] as const,
  detail: (id: string) => ['live-syncs', 'detail', id] as const,
}

export const liveSyncApi = {
  list: () => api.get<LiveSyncsList>('live-syncs'),
  get: (id: string) => api.get<LiveSyncDetail>(path`live-syncs/${id}`),
  /** W4.6: the owner's rejected-records file (a plain link: the browser downloads it). */
  rejectedUrl: (id: string) => new URL(path`live-syncs/${id}/rejected`, apiBase()).href,
  /** W4.6: the lag history the server keeps (the last minutes). */
  lag: (id: string, minutes: number) => api.get<LiveSyncLag>(path`live-syncs/${id}/lag?minutes=${minutes}`),
  /** W4.6: the last verification's samples (its owner only). */
  verifySamples: (id: string) => api.get<LiveSyncVerifySamples>(path`live-syncs/${id}/verify/samples`),
  plan: (connectionId: string, body: object, init?: { signal?: AbortSignal }) =>
    api.post<LiveSyncPlan>(path`connections/${connectionId}/live-syncs/plan`, body, init),
  create: (connectionId: string, body: object) =>
    api.post<LiveSyncView>(path`connections/${connectionId}/live-syncs`, body),
  pause: (id: string) => api.post<LiveSyncView>(path`live-syncs/${id}/pause`),
  resume: (id: string) => api.post<LiveSyncView>(path`live-syncs/${id}/resume`),
  stop: (id: string) => api.post<LiveSyncView>(path`live-syncs/${id}/stop`),
  skip: (id: string) => api.post<LiveSyncView>(path`live-syncs/${id}/skip`),
  verify: (id: string) => api.post<LiveSyncView>(path`live-syncs/${id}/verify`),
  finish: (id: string, verify: boolean) => api.post<LiveSyncView>(path`live-syncs/${id}/finish`, { verify }),
  applySchema: (id: string, ignore: boolean) =>
    api.post<LiveSyncView>(path`live-syncs/${id}/apply-schema`, { ignore }),
  remove: (id: string) => api.delete<void>(path`live-syncs/${id}`),
  review: (connectionId: string, id: string, body: object = {}) =>
    api.post<LiveSyncPlan>(path`connections/${connectionId}/live-syncs/${id}/review`, body),
  confirm: (connectionId: string, id: string, body: object) =>
    api.post<LiveSyncView>(path`connections/${connectionId}/live-syncs/${id}/confirm`, body),
}
