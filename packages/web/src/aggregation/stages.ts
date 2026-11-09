// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  QueryParseError,
  deserializeValue,
  formatShell,
  parsePipeline,
  parseShellExpression,
  serializeValue,
  stageOperator,
  templateFor,
} from '@mongo-manager/shared/browser'

/** Phase 2a spec §4.1: one stage card. `text` is the shell text of the stage's value. */
export interface Card {
  id: string
  operator: string
  text: string
  enabled: boolean
  collapsed: boolean
}

export interface StageError {
  message: string
  line?: number
  column?: number
}

let counter = 0
const nextId = () => `stage-${++counter}-${Math.random().toString(36).slice(2, 8)}`

/** A new card for the operator, starting from its template. */
/** The stages as the cards hold them: what a hand-over to run is checked against (review 2026-10-13, M4). */
export const cardsKey = (cards: readonly Card[]): string =>
  JSON.stringify(cards.map((c) => [c.operator, c.text, c.enabled]))

export function newCard(operator: string): Card {
  return { id: nextId(), operator, text: templateFor(operator) ?? '{}', enabled: true, collapsed: false }
}

/**
 * Saved stages (canonical EJSON) as cards: a saved pipeline, a Library item or a history entry.
 * A stage that cannot be read is left out and counted, never thrown (final review 2c, Minor 15).
 */
export function cardsFromStages(stages: unknown): { cards: Card[]; unreadable: number } {
  const list = Array.isArray(stages) ? stages : []
  const cards: Card[] = []
  for (const raw of list) {
    try {
      const stage = deserializeValue<Record<string, unknown>>(raw)
      const operator = stageOperator(stage)
      if (!operator) continue
      cards.push({ ...newCard(operator), text: formatShell(stage[operator], { indent: 2 }) })
    } catch {
      // Counted below.
    }
  }
  return { cards, unreadable: list.length - cards.length }
}

const positioned = (e: unknown): StageError =>
  e instanceof QueryParseError
    ? { message: e.message, line: e.line, column: e.column }
    : { message: (e as Error)?.message ?? String(e) }

/** The decoded value of a card, or why it has none. */
export function parseCard(card: Card): { value: unknown } | { error: StageError } {
  if (!card.text.trim()) return { error: { message: 'empty' } }
  try {
    return { value: parseShellExpression(card.text) }
  } catch (e) {
    return { error: positioned(e) }
  }
}

export interface Built {
  /** The enabled stages up to the first that does not parse, as canonical EJSON. */
  stages: Record<string, unknown>[]
  /** The same stages, decoded (for export). */
  values: Record<string, unknown>[]
  /** Card id of each sent stage: previews map back through it. */
  map: string[]
  error: (StageError & { cardId: string }) | null
}

/** The pipeline the enabled cards make, stopping at the first card that does not parse. */
export function toPipeline(cards: readonly Card[]): Built {
  const built: Built = { stages: [], values: [], map: [], error: null }
  for (const card of cards) {
    if (!card.enabled) continue
    const parsed = parseCard(card)
    if ('error' in parsed) {
      built.error = { ...parsed.error, cardId: card.id }
      break
    }
    const stage = { [card.operator]: parsed.value }
    built.values.push(stage)
    built.stages.push(serializeValue(stage) as Record<string, unknown>)
    built.map.push(card.id)
  }
  return built
}

/** Cards → the whole pipeline as text (disabled cards are left out). */
export function toText(cards: readonly Card[]): { text: string } | { error: StageError } {
  const built = toPipeline(cards)
  if (built.error) return { error: built.error }
  return { text: formatShell(built.values, { indent: 2 }) }
}

/**
 * The disabled cards of `previous` put back among `cards` (the enabled stages the text gave), each
 * after as many enabled stages as preceded it before (final review 2a, I2): the text leaves them
 * out, and coming back from it must not delete them.
 */
function withDisabled(cards: Card[], previous: readonly Card[]): Card[] {
  const placed: Array<{ after: number; card: Card }> = []
  let enabledBefore = 0
  for (const card of previous) {
    if (card.enabled) enabledBefore++
    else placed.push({ after: enabledBefore, card })
  }
  const out: Card[] = []
  for (let k = 0; k <= cards.length; k++) {
    for (const p of placed) if (Math.min(p.after, cards.length) === k) out.push(p.card)
    if (k < cards.length) out.push(cards[k]!)
  }
  return out
}

/**
 * Text → cards. The text holds the enabled stages: a card keeps its id and collapsed state when the
 * enabled stage at its place has the same operator, and disabled cards are kept where they were.
 * Empty text is a pipeline with no enabled stage.
 */
export function fromText(text: string, previous: readonly Card[]): { cards: Card[] } | { error: StageError } {
  if (!text.trim()) return { cards: withDisabled([], previous) }
  let stages: Record<string, unknown>[]
  try {
    stages = parsePipeline(text)
  } catch (e) {
    return { error: positioned(e) }
  }
  const enabled = previous.filter((c) => c.enabled)
  const cards: Card[] = []
  for (const [i, stage] of stages.entries()) {
    const operator = stageOperator(stage)
    if (!operator) return { error: { message: `Stage ${i + 1} must have exactly one $ operator` } }
    const before = enabled[i]
    const same = before && before.operator === operator
    cards.push({
      id: same ? before.id : nextId(),
      operator,
      text: formatShell(stage[operator], { indent: 2 }),
      enabled: true,
      collapsed: same ? before.collapsed : false,
    })
  }
  return { cards: withDisabled(cards, previous) }
}
