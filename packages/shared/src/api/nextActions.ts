// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { UiLanguageSchema } from '../languages'
import { CollectionNameSchema, DatabaseNameSchema } from '../schemas'

/**
 * completion W6.2: the Overview's next steps. They are worked out without AI, in the browser and
 * from what the server already reports (recent places, index advice, failed jobs, alerts, schedules,
 * live syncs). Only when the user turns it on, and an AI provider is set up, are they sent to be put
 * in order and reworded — as these facts: a kind, names and counts. Never a value or a document.
 */
export const NEXT_ACTION_KINDS = [
  'alerts',
  'failedJobs',
  'liveSyncs',
  'schedules',
  'createIndex',
  'slowQueries',
  'continue',
] as const
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number]

export const NEXT_ACTION_LIMITS = { items: 12, titleChars: 90, dismissed: 100, idChars: 300 } as const

/** A field name as an index key names it (no values: only the names suggested for an index). */
const FieldName = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.includes('\0') && !/[\r\n]/.test(s), 'Not a field name')

export const NextActionFactsSchema = z
  .strictObject({
    /** The browser's own id for it, to put the answer back together ("a0"…"a11"). */
    id: z.string().regex(/^a\d{1,2}$/),
    kind: z.enum(NEXT_ACTION_KINDS),
    connectionId: z.string().min(1).max(64).optional(),
    db: DatabaseNameSchema.optional(),
    coll: CollectionNameSchema.optional(),
    fields: z.array(FieldName).max(32).optional(),
    count: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  // A name is always of a connection, whose AI policy decides whether it may be sent.
  .refine((f) => !(f.db || f.coll || f.fields) || !!f.connectionId, 'Names need their connection')
export type NextActionFacts = z.infer<typeof NextActionFactsSchema>

export const NextActionsRankSchema = z.strictObject({
  language: UiLanguageSchema,
  items: z
    .array(NextActionFactsSchema)
    .min(1)
    .max(NEXT_ACTION_LIMITS.items)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Ids must be unique'),
})
export type NextActionsRankRequest = z.infer<typeof NextActionsRankSchema>

export interface NextActionsRanked {
  /** The ids sent, most useful first (an id not sent is never in it). */
  order: string[]
  /** A short title for each, in the language asked; the browser's own title where none came. */
  titles: Record<string, string>
  /** Ids left out because their connection's AI policy (or the user's rights there) does not allow it. */
  withheld: string[]
  provider: { name: string; model: string } | null
  /** Why nothing was ordered: the provider's answer could not be read, or nothing could be sent. */
  reason?: 'unreadable' | 'nothing_allowed'
}
