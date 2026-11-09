// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ConvertSamplesRequest, ConvertSamplesResponse, ConvertedSample } from '@mongo-manager/shared'
import { asText, convert } from './infer'
import { bsonKind, ejsonText } from './bson-kind'

/** What a converted sample shows: at most this many characters. */
const SHOWN = 200

function kindOf(v: unknown): Extract<ConvertedSample, { ok: true }>['kind'] {
  if (v === null) return 'null'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (v instanceof Date) return 'date'
  if (Array.isArray(v)) return 'array'
  switch (bsonKind(v)) {
    case 'Int32':
      return 'int32'
    case 'Long':
      return 'int64'
    case 'Double':
      return 'double'
    case 'Decimal128':
      return 'decimal128'
    case 'ObjectId':
      return 'objectId'
    case undefined:
      return typeof v === 'object' ? 'object' : 'other'
  }
  return 'other'
}

/**
 * W4.1: sample text in the mapping's target types, converted by the import's own rules (infer.ts), so
 * the mapping step shows what the import would write. Pure: the text is the caller's own.
 */
export function convertSamples(req: {
  items: ConvertSamplesRequest['items']
  allowUnusualKeys?: boolean
}): ConvertSamplesResponse {
  const opts = { allowUnusual: req.allowUnusualKeys ?? false }
  return {
    items: req.items.map(({ type, values }) =>
      values.map((raw): ConvertedSample => {
        const c = convert(raw, type, opts)
        if (!c.ok) return { ok: false, reason: c.reason.slice(0, SHOWN) }
        const kind = kindOf(c.value)
        const text =
          kind === 'object' || kind === 'array' || kind === 'other'
            ? ejsonText(c.value, { relaxed: true })
            : kind === 'null'
              ? 'null'
              : asText(c.value)
        return { ok: true, text: text.slice(0, SHOWN), kind }
      }),
    ),
  }
}
