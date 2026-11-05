// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, inject, provide, ref, type InjectionKey, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { matchesAny, ruleSegments } from '@mongo-manager/shared/browser'
import { personalFieldKeys, personalFieldsApi } from '@/api/personalFields'

type Matcher = (path: readonly string[]) => boolean
export const MASKED_PATH: InjectionKey<Ref<Matcher>> = Symbol('maskedPath')
const NONE: Matcher = () => false

/**
 * Phase 3c §7: which paths the server hides from this user in one collection. It only guides the
 * display (locks, a hint); the server alone decides what is hidden.
 */
export function provideMaskedPaths(connectionId: Ref<string>, db: Ref<string>, coll: Ref<string>) {
  const applied = useQuery({
    queryKey: computed(() => personalFieldKeys.applied(connectionId.value, db.value, coll.value)),
    queryFn: () => personalFieldsApi.applied(connectionId.value, db.value, coll.value),
    staleTime: 60_000,
  })
  // The server resolves a view to what it reads (final review M4); the rules are the fallback.
  const patterns = computed<readonly (readonly string[])[]>(
    () =>
      applied.data.value?.patterns ??
      (applied.data.value?.rules ?? [])
        // W5: a watch over a database (no collection) or the deployment (neither) takes every rule in it.
        .filter(
          (r) =>
            (!db.value || r.db === '*' || r.db === db.value) &&
            (!coll.value || r.coll === '*' || r.coll === coll.value),
        )
        .map((r) => ruleSegments(r.field)),
  )
  return provideMaskedPatterns(patterns)
}

/** Marks the given hidden paths (an aggregation's output paths, as its preview reports them). */
export function provideMaskedPatterns(patterns: Ref<readonly (readonly string[])[]>) {
  const matcher = computed<Matcher>(() =>
    patterns.value.length ? (p) => matchesAny(patterns.value, p) : NONE,
  )
  provide(MASKED_PATH, matcher)
  return { matcher, hidden: computed(() => patterns.value.length > 0) }
}

/** The matcher a collection view provided; nothing is marked outside one. */
export const useMaskedPath = (): Ref<Matcher> => inject(MASKED_PATH, ref(NONE))

/** The first keys of canonical EJSON values. */
const EJSON_KEYS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$symbol',
  '$code',
  '$minKey',
  '$maxKey',
  '$dbPointer',
  '$undefined',
  '$ref',
])

/**
 * A copy of a document where each value the server hides is replaced by `onHidden` (dropped when it
 * answers DROP). Canonical EJSON wrappers ({ $oid }, …) and BSON values are leaves, not documents.
 */
const DROP = Symbol('drop')
function mapHidden(
  value: unknown,
  isMasked: (p: readonly string[]) => boolean,
  onHidden: (path: string[]) => unknown,
): unknown {
  const walk = (v: unknown, path: string[]): unknown => {
    if (Array.isArray(v))
      return v.map((x, i) => {
        const p = [...path, String(i)]
        return x === '***' && isMasked(p) ? onHidden(p) : walk(x, p)
      })
    // Only plain documents are walked: BSON values (Double, ObjectId…) and EJSON wrappers are leaves.
    if (!v || typeof v !== 'object') return v
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return v
    const keys = Object.keys(v)
    // A canonical EJSON wrapper ({ $oid }, { $date }, …) is a value; other $-named fields are fields (M6).
    if (keys.length > 0 && EJSON_KEYS.has(keys[0]!) && keys.every((k) => k.startsWith('$'))) return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const p = [...path, k]
      const next = x === '***' && isMasked(p) ? onHidden(p) : walk(x, p)
      if (next !== DROP) out[k] = next
    }
    return out
  }
  return walk(value, [])
}

/**
 * Phase 3c §7: a copy without the values the server hides (a clone cannot write them back), and the
 * paths it left out.
 */
export function stripMasked(
  value: Record<string, unknown>,
  isMasked: (p: readonly string[]) => boolean,
): { value: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = []
  const out = mapHidden(value, isMasked, (p) => {
    // An array keeps its slots (a clone of an array cannot leave a hole); a field is left out.
    if (/^\d+$/.test(p[p.length - 1]!)) return '***'
    dropped.push(p.join('.'))
    return DROP
  })
  return { value: out as Record<string, unknown>, dropped }
}

/**
 * W5: the text that stands for a hidden value in shell JSON, so a code view can show it with a lock
 * (as the table does). Random per page load: a stored string can never pass for it.
 */
const HIDDEN_MARK = `${Math.random().toString(36).slice(2)}`
export const HIDDEN_TOKEN = JSON.stringify(HIDDEN_MARK)

/** A copy of the document with each hidden value replaced by the mark a code view shows locked. */
export const markHidden = (value: unknown, isMasked: (p: readonly string[]) => boolean): unknown =>
  mapHidden(value, isMasked, () => HIDDEN_MARK)
