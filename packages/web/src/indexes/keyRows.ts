// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { parseQueryObject } from '@mongo-manager/shared/browser'
import { typeOf } from '@/documents/values'

/** UI redesign R2 §3: an index key as rows of field and kind, kept two-way with its shell text. */
export const KEY_KINDS = ['1', '-1', 'text', 'hashed', '2dsphere', '2d'] as const
export type KeyKind = (typeof KEY_KINDS)[number]
export interface KeyRow {
  field: string
  kind: KeyKind
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** The rows as the keys' shell text; rows without a field are left out (they are still being typed). */
export function rowsToText(rows: readonly KeyRow[]): string {
  const parts = rows
    .filter((r) => r.field.trim() !== '')
    .map((r) => {
      const field = r.field.trim()
      const name = IDENTIFIER.test(field) ? field : JSON.stringify(field)
      const value = r.kind === '1' || r.kind === '-1' ? r.kind : `'${r.kind}'`
      return `${name}: ${value}`
    })
  return parts.length === 0 ? '' : `{ ${parts.join(', ')} }`
}

/** The keys' text as rows, or null when it is not a plain key the rows can show (or does not parse). */
export function textToRows(text: string): KeyRow[] | null {
  if (!text.trim()) return []
  let parsed: Record<string, unknown>
  try {
    parsed = parseQueryObject(text)
  } catch {
    return null
  }
  const rows: KeyRow[] = []
  for (const [field, raw] of Object.entries(parsed)) {
    const type = typeOf(raw)
    const n = type === 'int32' || type === 'double' ? Number((raw as { valueOf(): number }).valueOf()) : NaN
    if (n === 1 || n === -1) rows.push({ field, kind: n === 1 ? '1' : '-1' })
    else if (typeof raw === 'string' && (KEY_KINDS as readonly string[]).includes(raw))
      rows.push({ field, kind: raw as KeyKind })
    else return null
  }
  return rows
}
