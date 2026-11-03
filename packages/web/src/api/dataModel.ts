import type { DataModel } from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** completion W6.4: a database's data model. */
export const dataModelKeys = {
  model: (id: string, db: string, sampleSize: number) =>
    ['connections', id, 'databases', db, 'model', sampleSize] as const,
}

export const dataModelApi = {
  /** Leaving the section cancels the request, and the server stops reading with it. */
  get: (id: string, db: string, sampleSize: number, signal?: AbortSignal) =>
    api.get<DataModel>(`${path`connections/${id}/databases/${db}`}/model?sampleSize=${sampleSize}`, {
      signal,
    }),
}
