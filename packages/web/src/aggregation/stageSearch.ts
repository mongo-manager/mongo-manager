// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { STAGES } from '@mongo-manager/shared/browser'

/**
 * W2 review (minor 7): text folded the same way whatever the browser's language — toLowerCase, not
 * toLocaleLowerCase (in Turkish "LIMIT" becomes "lımıt"), with I, İ and ı all read as i.
 */
export const fold = (text: string): string => text.replace(/İ/g, 'I').toLowerCase().replace(/ı/g, 'i')

/**
 * W2.5 (2026-10-16): the stages that answer what was typed — operators that start with it first,
 * then those that contain it, then those whose description says it ("join" finds $lookup). Every
 * stage, in the catalogue's order, for nothing typed.
 */
export function searchStages(query: string, describe: (operator: string) => string): string[] {
  const all = STAGES.map((s) => s.operator)
  const q = fold(query.trim()).replace(/^\$/, '')
  if (!q) return all
  const name = (op: string) => fold(op.slice(1))
  const starts = all.filter((op) => name(op).startsWith(q))
  const contains = all.filter((op) => !starts.includes(op) && name(op).includes(q))
  const words = all.filter(
    (op) => !starts.includes(op) && !contains.includes(op) && fold(describe(op)).includes(q),
  )
  return [...starts, ...contains, ...words]
}
