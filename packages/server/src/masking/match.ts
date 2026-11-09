// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { globCovers, matchesAny, ruleSegments, underAny, type PersonalRule } from '@mongo-manager/shared'
import { hostsKeyVault, isEncryptionNamespace } from '../connections/access'

/** A rule's field path as segments (`**.phone` → ['**', 'phone']). */
export type Pattern = readonly string[]

/** Phase 3b spec §2.3: which field paths of a namespace hold personal data. */
export interface NsMasker {
  /** Some rule applies to this namespace. */
  any: boolean
  /** The rules' field paths that apply here (phase 3c: the query gate grows them). */
  patterns: readonly Pattern[]
  /** The path itself is personal: a rule names it or a field above it (security review 2026-10-13, C1). */
  matches(path: readonly string[]): boolean
  /**
   * Something below the path may be personal. It says nothing of the path itself or what is above
   * it: ask `matches` too (review M1 — a branch that asked only this left values unmasked).
   */
  under(path: readonly string[]): boolean
  /** A rule here matches every path the given pattern names (review M3). */
  covers(pattern: readonly string[]): boolean
}

export interface Masker {
  /** Some rule exists: what cannot be tied to a namespace is masked (in doubt, mask). */
  anyRules: boolean
  /** Some rule can apply to a namespace of this database (phase 3c §6). */
  anyInDb(db: string): boolean
  forNs(db: string, coll: string): NsMasker
}

const NONE: NsMasker = {
  any: false,
  patterns: [],
  matches: () => false,
  under: () => false,
  covers: () => false,
}
const MAX_CACHED_NAMESPACES = 1000

/**
 * A masker for a fixed set of patterns: a namespace's rules, or what a query moved them into.
 * Array positions in a path are transparent (`items.0.cardNo` is `items.cardNo`, final review C4).
 */
export function nsMaskerFrom(patterns: readonly Pattern[]): NsMasker {
  if (patterns.length === 0) return NONE
  return {
    any: true,
    patterns,
    matches: (path) => matchesAny(patterns, path),
    under: (path) => underAny(patterns, path),
    covers: (pattern) => patterns.some((p) => globCovers(p, pattern)),
  }
}

const KEY_VAULT_PATTERNS: readonly Pattern[] = [['keyMaterial'], ['keyAltNames'], ['masterKey']]

export function compileRules(rules: readonly PersonalRule[]): Masker {
  const compiled = rules.map((r) => ({ db: r.db, coll: r.coll, path: ruleSegments(r.field) }))
  const cache = new Map<string, NsMasker>()
  return {
    anyRules: compiled.length > 0,
    anyInDb: (db) => compiled.some((r) => r.db === '*' || r.db === db) || hostsKeyVault(db),
    forNs(db, coll) {
      // Security review C1 (Minor 10): a key vault's data keys and alternate names (often a
      // person's) are hidden whatever the rules say; never cached, as key vaults follow connections.
      if (isEncryptionNamespace(db, coll))
        return nsMaskerFrom([
          ...KEY_VAULT_PATTERNS,
          ...compiled
            .filter((r) => (r.db === '*' || r.db === db) && (r.coll === '*' || r.coll === coll))
            .map((r) => r.path),
        ])
      const key = JSON.stringify([db, coll])
      let ns = cache.get(key)
      if (!ns) {
        ns = nsMaskerFrom(
          compiled
            .filter((r) => (r.db === '*' || r.db === db) && (r.coll === '*' || r.coll === coll))
            .map((r) => r.path),
        )
        if (cache.size < MAX_CACHED_NAMESPACES) cache.set(key, ns)
      }
      return ns
    },
  }
}
