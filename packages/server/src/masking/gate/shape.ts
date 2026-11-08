// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MAX_PATH_SEGMENTS, matchesAny, underAny } from '@mongo-manager/shared'
import { nsMaskerFrom, type NsMasker, type Pattern } from '../match'
import { reroot } from '../patterns'
import { notSupported } from './refusal'

export const MAX_SHAPE_PATTERNS = 2000
const key = (p: Pattern) => JSON.stringify(p)

/**
 * Phase 3c §3.4: which paths of the documents at one point of a query are, or may hold, personal
 * data. It only grows: a field computed under a personal name stays masked (over-masking is
 * harmless, under-masking is not).
 */
export class Shape {
  private readonly patterns = new Map<string, Pattern>()
  private cached: Pattern[] | null = null

  constructor(
    readonly ns: string,
    initial: readonly Pattern[] = [],
  ) {
    this.add(initial)
  }

  get any(): boolean {
    return this.patterns.size > 0
  }

  list(): Pattern[] {
    return (this.cached ??= [...this.patterns.values()])
  }

  add(list: readonly Pattern[]): void {
    // A pattern naming the root is the whole document (review 2026-10-13, M2: it matched nothing).
    for (const p of list) {
      const q = p.length === 0 ? ['**'] : p
      this.patterns.set(key(q), q)
    }
    this.cached = null
    if (this.patterns.size > MAX_SHAPE_PATTERNS) throw notSupported('A query this complex', this.ns)
  }

  /** The path, or a field above it, is personal. A path deeper than any field is refused (review I1). */
  personal(path: readonly string[]): boolean {
    if (path.length > MAX_PATH_SEGMENTS) throw notSupported('A field path this deep', this.ns)
    return path.length > 0 && matchesAny(this.list(), path)
  }

  /** Something at or below the path may be personal: the root may hold anything a rule names. */
  mayHold(path: readonly string[]): boolean {
    return this.any && underAny(this.list(), path)
  }

  moved(from: readonly string[], to: readonly string[]): void {
    this.add(reroot(this.list(), from, to))
  }

  nest(prefix: readonly string[], list: readonly Pattern[]): void {
    this.add(list.map((p) => [...prefix, ...p]))
  }

  clone(ns = this.ns): Shape {
    return new Shape(ns, this.list())
  }

  output(): NsMasker {
    return nsMaskerFrom(this.list())
  }
}
