// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { BsonTypeName } from '@mongo-manager/shared/browser'

/** UI redesign R1: each BSON type has its value colour in both themes (cells, cards, the tree). */
export function valueTone(type: BsonTypeName | null): string {
  switch (type) {
    case 'string':
      return 'text-v-string'
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return 'text-v-number'
    case 'objectId':
      return 'text-v-oid'
    case 'date':
    case 'uuid':
      return 'text-v-date'
    case 'boolean':
      return 'text-v-boolean'
    case 'null':
    case 'undefined':
      return 'text-v-null'
    default:
      return 'text-fg-muted'
  }
}
