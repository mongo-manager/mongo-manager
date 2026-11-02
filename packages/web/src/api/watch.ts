import type { WatchRecording, WatchRecordingPage } from '@mongo-manager/shared/browser'
import { api, path } from './client'

const apiBase = () => new URL('api/', document.baseURI)
const recordings = (connectionId: string) => path`connections/${connectionId}/watch/recordings`

/** W4.7: the Watch page's calls that are not the feed itself (that runs over the socket). */
export const watchApi = {
  /** A collection's pre- and post-images on or off (a collMod). */
  setPreImages: (connectionId: string, db: string, coll: string, enabled: boolean) =>
    api.put<{ enabled: boolean }>(
      path`connections/${connectionId}/databases/${db}/collections/${coll}/pre-images`,
      { enabled },
    ),
  /** The caller's recorded feeds of a connection. */
  recordings: (connectionId: string) => api.get<WatchRecording[]>(recordings(connectionId)),
  /**
   * W4 review I9: a page of a recording's events, as recorded, from a place the previous page gave
   * (the server reads at most 500 events or 2 MiB a page, and keeps a line still being written).
   */
  page: (connectionId: string, fileId: string, from: number) =>
    api.get<WatchRecordingPage>(
      `${recordings(connectionId)}/${encodeURIComponent(fileId)}/events?from=${encodeURIComponent(String(from))}`,
    ),
  /** A plain link: the browser downloads the file. */
  downloadUrl: (connectionId: string, fileId: string) =>
    new URL(`${recordings(connectionId)}/${encodeURIComponent(fileId)}`, apiBase()).href,
  remove: (connectionId: string, fileId: string) =>
    api.delete<void>(`${recordings(connectionId)}/${encodeURIComponent(fileId)}`),
}
