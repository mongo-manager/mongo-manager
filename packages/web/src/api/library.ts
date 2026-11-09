// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FavouriteBody, FavouriteView, LibraryItem, LibraryPin } from '@mongo-manager/shared/browser'
import { api, path } from './client'
import type { CollectionTarget } from './documents'

const base = (t: CollectionTarget) =>
  path`connections/${t.connectionId}/databases/${t.db}/collections/${t.coll}`

/** Phase 2c: favourite finds of a collection. */
export const favouritesApi = {
  list: (t: CollectionTarget) => api.get<{ favourites: FavouriteView[] }>(`${base(t)}/favourites`),
  create: (t: CollectionTarget, body: FavouriteBody) =>
    api.post<FavouriteView>(`${base(t)}/favourites`, body),
  update: (t: CollectionTarget, id: string, body: FavouriteBody) =>
    api.put<FavouriteView>(`${base(t)}/favourites/${encodeURIComponent(id)}`, body),
  remove: (t: CollectionTarget, id: string) =>
    api.delete<void>(`${base(t)}/favourites/${encodeURIComponent(id)}`),
}

export interface LibrarySearch {
  q?: string
  tags?: string[]
  type?: LibraryItem['type']
  db?: string
  coll?: string
  limit?: number
}

/** Phase 2c: the connection's library: favourites, saved pipelines and history. */
export const libraryApi = {
  search: (connectionId: string, s: LibrarySearch, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (s.q) params.set('q', s.q)
    if (s.tags?.length) params.set('tags', s.tags.join(','))
    if (s.type) params.set('type', s.type)
    if (s.db) params.set('db', s.db)
    if (s.coll) params.set('coll', s.coll)
    if (s.limit) params.set('limit', String(s.limit))
    const query = params.toString()
    return api.get<{ items: LibraryItem[]; truncated: boolean; tags: string[] }>(
      `${path`connections/${connectionId}/library`}${query ? `?${query}` : ''}`,
      signal ? { signal } : undefined,
    )
  },
  removeHistory: (connectionId: string, id: string) =>
    api.delete<void>(path`connections/${connectionId}/library/history/${id}`),
  clearHistory: (connectionId: string) => api.delete<void>(path`connections/${connectionId}/library/history`),
  /** W1 (completion §2): pin or unpin a saved query, for the signed-in user only. */
  pin: (connectionId: string, pin: LibraryPin) =>
    api.put<{ pinned: boolean }>(path`connections/${connectionId}/library/pins`, pin),
}

export const libraryKeys = {
  favourites: (t: CollectionTarget) =>
    ['connections', t.connectionId, 'databases', t.db, 'collections', t.coll, 'favourites'] as const,
  search: (connectionId: string, s: LibrarySearch) => ['connections', connectionId, 'library', s] as const,
}
