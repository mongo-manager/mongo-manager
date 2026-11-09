// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ConnectionRecord } from '../connections/repo'

/**
 * How the assistant names connections, the same in agent mode and in the general chat (review of
 * fa862922, nit 9): by name; connections of one name told apart by their group, else by the start of
 * their id — never by an address. Each carries it, so none borrows another's name (W6.3 security
 * review, minor 4).
 */
export function connectionLabels(records: readonly ConnectionRecord[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const c of records) count.set(c.name, (count.get(c.name) ?? 0) + 1)
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const c of records) {
    const groups = records.filter((x) => x.name === c.name && x.group === c.group).length
    let label =
      (count.get(c.name) ?? 0) < 2
        ? c.name
        : c.group && groups === 1
          ? `${c.name} · ${c.group}`
          : `${c.name} · ${c.id.slice(0, 8)}`
    if (used.has(label)) label = `${c.name} · ${c.id}`
    used.add(label)
    out.set(c.id, label)
  }
  return out
}

/** A connection the assistant was told of: its id, its label and its bare name. */
export interface Named {
  id: string
  label: string
  name: string
}

/**
 * Text folded for matching, whatever the host's locale (fourth review, M-A): marks dropped, then
 * lower case, the dotless i as i — so "İSTANBUL", "ıstanbul" and "Istanbul" meet — and spaces,
 * hyphens and underscores as one space (fifth review, M2: "Sales-Mongo", "Sales_Mongo"). Matching too
 * much only keeps a turn back; matching too little would let a name travel.
 */
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[\s_-]+/g, ' ')
    .trim()

/** As fold, separators kept: "－－", "__" and "--" alike — for a name of nothing else. */
const separators = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/_/g, '-').replace(/\s+/g, ' ').trim()

/** Fifth review (M1): a name this short is named only as a word — "db" not by "mongodb". */
const SHORT = 3
/**
 * What continues a word, in Latin, Greek, Cyrillic, Armenian and Georgian text and digits (sixth
 * review): elsewhere — Japanese and Chinese have no spaces, Korean joins its endings — a short name
 * matches anywhere, or it might never match at all.
 */
const WORDY =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{N}]/u
const wordy = (c: string | undefined) => c !== undefined && WORDY.test(c)
/** The character before `at`, a surrogate pair read whole — in constant time (seventh review, I1). */
function before(s: string, at: number): string | undefined {
  if (at <= 0) return undefined
  const low = s.charCodeAt(at - 1)
  const pair = at >= 2 && (low & 0xfc00) === 0xdc00 && (s.charCodeAt(at - 2) & 0xfc00) === 0xd800
  return s.slice(pair ? at - 2 : at - 1, at)
}
const after = (s: string, at: number) =>
  at < s.length ? String.fromCodePoint(s.codePointAt(at)!) : undefined

/** Read as text, never as a pattern (sixth review, nit 4): no name can fail a turn. */
function found(folded: string, name: string): boolean {
  if (name.length > SHORT) return folded.includes(name)
  for (let at = folded.indexOf(name); at !== -1; at = folded.indexOf(name, at + 1))
    if (!wordy(before(folded, at)) && !wordy(after(folded, at + name.length))) return true
  return false
}

/**
 * The connections an answer names, by their label or their bare name (fourth review, M-B: a model
 * often drops a label's " · group"): those its turn records as named.
 */
export function namedIn(text: string, candidates: readonly Named[]): string[] {
  const folded = fold(text)
  // A name of separators only folds to nothing: read as the folding reads it, separators kept
  // (ninth review; tenth: full-width, underscores, spaces of any kind).
  const kept = separators(text)
  const hit = (n: string) => {
    const f = fold(n)
    return f ? found(folded, f) : separators(n) !== '' && kept.includes(separators(n))
  }
  return [...new Set(candidates.filter((c) => [c.label, c.name].some(hit)).map((c) => c.id))]
}

/**
 * The record's `named`, kept out of it when none: those the answer names, and those the history it
 * was written from named (fourth review, I-A: an answer may repeat a name it was sent) — sources
 * apart, which are checked as such.
 */
export function namedOf(
  text: string,
  candidates: readonly Named[],
  carried: readonly string[],
  sources: ReadonlyMap<string, unknown>,
): { named?: string[] } {
  const named = [...new Set([...carried, ...namedIn(text, candidates)])].filter((id) => !sources.has(id))
  return named.length ? { named } : {}
}
