// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'
import { SealedItemRepo, type SealedItemKey } from './sealed-items'

/** Phase 2c spec §2.1. */
export const MAX_FAVOURITES_PER_NAMESPACE = 200
export const MAX_FAVOURITE_BYTES = 64 * 1024

/** Sealing context: a sealed query copied to another row or collection no longer opens. */
export const favouriteContext = (r: SealedItemKey) =>
  `favourite:${JSON.stringify([r.id, r.connection_id, r.db, r.coll])}`

/** Phase 2c: finds saved by name and tags; the query is sealed, as it can hold personal data. */
export class FavouriteRepo extends SealedItemRepo {
  constructor(db: DatabaseSync, box: SecretBox, now: () => number) {
    super(db, box, now, { table: 'saved_queries', column: 'query', context: favouriteContext })
  }
}
