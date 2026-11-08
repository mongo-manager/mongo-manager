// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

/**
 * Phase 3b spec §2.1: the fields of a connection that hold personal data. A rule names a database
 * and a collection (or `*`) and a dotted field path whose segments are names, `*` (one level) or
 * `**` (any depth). The last segment must be a name, so a rule can never mask a whole document.
 * Rules are stored structured because a collection name may itself contain dots.
 */
export const MAX_PERSONAL_RULES = 200
export const MAX_RULE_BYTES = 512

const NUL = String.fromCharCode(0)
const noNul = (v: string): boolean => !v.includes(NUL)
const DB_NAME = /^[^/\\. "$*<>:|?]{1,64}$/
const COLL_NAME = /^[^$]{1,255}$/
const SEGMENT = /^[^.$][^.]{0,127}$/
const dbName = (v: string): boolean => DB_NAME.test(v) && noNul(v)
const collName = (v: string): boolean => COLL_NAME.test(v) && noNul(v)
const segment = (v: string): boolean => SEGMENT.test(v) && noNul(v)

export interface PersonalRule {
  db: string
  coll: string
  field: string
}

export const ruleSegments = (field: string): string[] => field.split('.')

export const formatRule = (r: PersonalRule): string => `${r.db}.${r.coll}.${r.field}`

const validField = (field: string): boolean => {
  const segments = ruleSegments(field)
  if (segments.some((s) => s !== '*' && s !== '**' && !segment(s))) return false
  const last = segments.at(-1)!
  return last !== '*' && last !== '**'
}

export const PersonalRuleSchema = z
  .strictObject({
    db: z.string().refine((v) => v === '*' || dbName(v), 'Not a database name or *'),
    coll: z.string().refine((v) => v === '*' || collName(v), 'Not a collection name or *'),
    field: z.string().min(1).refine(validField, 'Not a field path ending in a name'),
  })
  .refine((r) => new TextEncoder().encode(formatRule(r)).length <= MAX_RULE_BYTES, {
    message: `A rule is at most ${MAX_RULE_BYTES} bytes`,
  })

export const PersonalRulesBodySchema = z
  .strictObject({ rules: z.array(PersonalRuleSchema).max(MAX_PERSONAL_RULES) })
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.rules.forEach((r, i) => {
      const key = JSON.stringify([r.db, r.coll, r.field])
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['rules', i], message: 'Duplicate rule' })
      seen.add(key)
    })
  })

export type PersonalRulesBody = z.infer<typeof PersonalRulesBodySchema>
