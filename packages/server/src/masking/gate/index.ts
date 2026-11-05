// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export {
  guardAggregate,
  guardCount,
  guardFilterFor,
  guardFind,
  guardOrder,
  type FindQuery,
  type GuardedFind,
} from './find'
export type { GateDeps } from './context'
export {
  MASKING_UNSUPPORTED,
  PERSONAL_FIELD,
  isOrderRefusal,
  isIndexesRefusal,
  IndexListingFailed,
  PERSONAL_WRITE,
  notSupported,
  orderRefused,
  personalField,
  personalWrite,
} from './refusal'
export {
  NOT_A_DOCUMENT,
  guardBulkUpdate,
  guardIndexBuild,
  guardValidator,
  guardViewSource,
  guardDocumentUpdate,
  guardInsert,
  guardInsertUnique,
  guardIndexesReadable,
  personalLocations,
  restoreReplacement,
  keySorted,
} from './write'
export { rulesFor } from './pipeline'
export { seriesStoredByHidden } from './order'
