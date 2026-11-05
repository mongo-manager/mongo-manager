// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { WatchEvent } from '@mongo-manager/shared'
import { MASK, bare, maskDocument } from './document'
import type { NsMasker } from './match'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Phase 3e-1 spec §3 W3 (masking 3c §6): a change event in canonical EJSON as a restricted user may
 * see it. The document, its key and its before-image are masked by the namespace's rules; updated
 * values are masked by their dotted path (array positions are transparent); removed fields are names
 * and truncated arrays carry sizes only. Masking runs before anything is elided.
 */
export function maskChangeEvent(event: WatchEvent, ns: NsMasker): WatchEvent {
  if (!ns.any) return event
  let masked = false
  const doc = (v: unknown): unknown => {
    if (v === undefined) return v
    const out = maskDocument(v, ns)
    if (!same(out, v)) masked = true
    return out
  }
  const out: WatchEvent = { ...event }
  if (event.documentKey !== undefined) out.documentKey = doc(event.documentKey)
  if (event.fullDocument !== undefined) out.fullDocument = doc(event.fullDocument)
  if (event.before !== undefined) out.before = doc(event.before)
  if (event.update) {
    const updated = bare()
    for (const [key, value] of Object.entries(event.update.updated)) {
      const path = key.split('.')
      const next = ns.matches(path) ? MASK : ns.under(path) ? maskDocument(value, ns, path) : value
      if (!same(next, value)) masked = true
      updated[key] = next
    }
    out.update = { ...event.update, updated: { ...updated } }
  }
  return masked || event.masked ? { ...out, masked: true } : out
}
