// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { GridFsBucket, GridFsFile, GridFsListQuery, GridFsPage } from '@mongo-manager/shared/browser'
import { api, apiHref, path } from './client'

/** Phase 4b §1: a database's GridFS buckets and their files. */
export type GridFsPreviewKind = 'image' | 'audio' | 'video' | 'text'
export type GridFsListFilter = Partial<Pick<GridFsListQuery, 'q' | 'sort' | 'dir'>>

const base = (connectionId: string, db: string, bucket: string) =>
  path`connections/${connectionId}/databases/${db}/gridfs/${bucket}/files`

export const gridfsKeys = {
  all: (connectionId: string, db: string) => ['gridfs', connectionId, db] as const,
  buckets: (connectionId: string, db: string) => ['gridfs', connectionId, db, 'buckets'] as const,
  files: (connectionId: string, db: string, bucket: string, filter: GridFsListFilter) =>
    ['gridfs', connectionId, db, bucket, 'files', filter] as const,
}

export const gridfsApi = {
  buckets: (connectionId: string, db: string) =>
    api.get<GridFsBucket[]>(path`connections/${connectionId}/databases/${db}/gridfs`),
  files: (
    connectionId: string,
    db: string,
    bucket: string,
    filter: GridFsListFilter,
    skip = 0,
    limit = 50,
  ) => {
    const query = new URLSearchParams({ skip: String(skip), limit: String(limit) })
    if (filter.q) query.set('q', filter.q)
    if (filter.sort) query.set('sort', filter.sort)
    if (filter.dir) query.set('dir', filter.dir)
    return api.get<GridFsPage>(`${base(connectionId, db, bucket)}?${query}`)
  },
  /** A file's preview: an image, a sound or a video by its bytes, else the start of its text. */
  preview: async (connectionId: string, db: string, bucket: string, id: string, signal?: AbortSignal) => {
    const { blob, headers } = await api.getBytes(
      `${base(connectionId, db, bucket)}/${encodeURIComponent(id)}/preview`,
      signal ? { signal } : undefined,
    )
    const kind = headers.get('x-preview-kind')
    return {
      kind: (kind === 'image' || kind === 'audio' || kind === 'video' ? kind : 'text') as GridFsPreviewKind,
      blob,
      truncated: headers.get('x-preview-truncated') === '1',
    }
  },
  /** A link the browser downloads with the session's cookie (an attachment that never renders). */
  downloadHref: (connectionId: string, db: string, bucket: string, id: string) =>
    apiHref(`${base(connectionId, db, bucket)}/${encodeURIComponent(id)}/download`),
  uploadHref: (connectionId: string, db: string, bucket: string, filename: string, contentType?: string) => {
    const query = new URLSearchParams({ filename })
    if (contentType) query.set('contentType', contentType)
    return apiHref(`${base(connectionId, db, bucket)}?${query}`)
  },
  patch: (
    connectionId: string,
    db: string,
    bucket: string,
    id: string,
    change: { filename?: string; metadata?: Record<string, unknown> | null; version?: string },
  ) => api.patch<GridFsFile>(`${base(connectionId, db, bucket)}/${encodeURIComponent(id)}`, change),
  remove: (connectionId: string, db: string, bucket: string, id: string) =>
    api.delete<void>(`${base(connectionId, db, bucket)}/${encodeURIComponent(id)}`),
}
