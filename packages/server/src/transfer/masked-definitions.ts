// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import { toClient } from '../data/ejson-io'
import { maskCollectionOptions, maskIndexOptions, maskValidator } from '../masking/definitions'
import { nsMaskerFrom, type Masker, type Pattern } from '../masking/match'
import type { IndexPlan, ViewDef } from './collection-spec'

/**
 * Security audit 2026-10-16 (Important 3): the masked backup's rule (backup/dump-plan.ts) for copies
 * and live syncs. A definition — a validator, an index's partial filter, a view's pipeline — holds
 * values as its author wrote them; one that masking would change names a value its reader may not
 * see, so a masked or anonymous copy leaves it out (never writes it masked: "***" would change what
 * it means) and says so. A collation, time series or clustered option holds no values.
 */
const changes = (before: unknown, after: unknown) => JSON.stringify(before) !== JSON.stringify(after)

export const VALIDATOR_LEFT_OUT = 'Its validator holds values that would be masked; it is left out'
export const PARTIAL_LEFT_OUT = 'Its partial filter holds values that would be masked; it is left out'

/** A masker of a source namespace's patterns alone (a live sync knows its patterns, not its rules). */
export const maskerOfPatterns = (patterns: readonly Pattern[]): Masker => {
  const ns = nsMaskerFrom(patterns)
  return { anyRules: patterns.length > 0, anyInDb: () => patterns.length > 0, forNs: () => ns }
}

/** New collection options without a validator masking would change; `left` says one was dropped. */
export function withoutMaskedValidator(
  options: Document,
  db: string,
  coll: string,
  masker: Masker,
): { options: Document; left: boolean } {
  if (options.validator === undefined) return { options, left: false }
  const validator = toClient(options.validator as Document)
  if (!changes(validator, maskValidator(validator, db, coll, masker))) return { options, left: false }
  const { validator: _v, validationLevel: _l, validationAction: _a, ...rest } = options
  return { options: rest, left: true }
}

/** Whether an index's options name a value masking would change (its partial filter). */
export const indexMasked = (index: Document, db: string, coll: string, masker: Masker): boolean => {
  const plain = toClient(index)
  return changes(plain, maskIndexOptions(plain, db, coll, masker))
}

/** An index plan without the indexes masking would change, each moved to `skipped`. */
export function withoutMaskedIndexes(
  plan: IndexPlan,
  db: string,
  coll: string,
  masker: Masker,
): { plan: IndexPlan; left: string[] } {
  const left = plan.build.filter((ix) => indexMasked(ix, db, coll, masker)).map((ix) => String(ix.name))
  if (!left.length) return { plan, left }
  return {
    plan: {
      build: plan.build.filter((ix) => !left.includes(String(ix.name))),
      skipped: [...plan.skipped, ...left.map((name) => ({ name, reason: PARTIAL_LEFT_OUT }))],
      ttl: plan.ttl.filter((name) => !left.includes(name)),
    },
    left,
  }
}

/** Whether a view's pipeline holds a value masking would change (masked against what it reads). */
export const viewMasked = (view: ViewDef, db: string, masker: Masker): boolean => {
  const options = toClient({ viewOn: view.viewOn, pipeline: view.pipeline })
  return changes(options, maskCollectionOptions(options, db, view.name, masker))
}
