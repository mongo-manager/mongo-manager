import type { JobView } from '@mongo-manager/shared'
import { api, path } from './client'

export const jobsApi = {
  list: () => api.get<{ jobs: JobView[] }>('jobs'),
  cancel: (id: string) => api.post<{ job: JobView }>(path`jobs/${id}/cancel`),
}

/** The real-time channel's URL, relative to <base href> like the API (works under any basePath). */
export function socketUrl(): string {
  const url = new URL('ws', document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
