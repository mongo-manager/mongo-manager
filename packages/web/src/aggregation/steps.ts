// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { PipelineAssistant } from '@mongo-manager/shared/browser'
import { cardsFromStages, toPipeline, type Card } from './stages'

/**
 * UI redesign R1 review: the assistant's steps — each request, its reply, the stages it led to and
 * what changed — shown, gone back to, and saved with the pipeline.
 */
export interface StepChange {
  kind: 'added' | 'changed' | 'removed'
  operator: string
  /** The stage's place (1-based) after the change, or before it for a removed one. */
  n: number
}
export interface AssistantStep {
  prompt: string
  reply: string
  cards: Card[]
  changes: StepChange[]
}

const keyOf = (c: Pick<Card, 'operator' | 'text'>) => `${c.operator}\u0000${c.text.trim()}`
const MAX_REPLY = 1000

/** The reply's words, without its code (the stages are shown as stages). */
export function replyOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REPLY)
}

/**
 * What changed from one pipeline to the next: stages kept in order are matched (longest common
 * subsequence); a removed and an added stage of the same operator at the same place are one change.
 */
export function changesBetween(before: readonly Card[], after: readonly Card[]): StepChange[] {
  const a = before.map(keyOf)
  const b = after.map(keyOf)
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const removed: Array<{ at: number; operator: string }> = []
  const added: Array<{ at: number; operator: string }> = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      added.push({ at: j, operator: after[j]!.operator })
      j++
    } else {
      removed.push({ at: i, operator: before[i]!.operator })
      i++
    }
  }
  const out: StepChange[] = []
  for (const add of added) {
    const twin = removed.findIndex((r) => r.operator === add.operator && r.at === add.at)
    if (twin >= 0) {
      removed.splice(twin, 1)
      out.push({ kind: 'changed', operator: add.operator, n: add.at + 1 })
    } else out.push({ kind: 'added', operator: add.operator, n: add.at + 1 })
  }
  for (const r of removed) out.push({ kind: 'removed', operator: r.operator, n: r.at + 1 })
  return out.sort((x, y) => x.n - y.n)
}

/** The steps as saved with a pipeline (each step's stages as canonical EJSON). */
export function assistantOf(steps: readonly AssistantStep[]): PipelineAssistant | undefined {
  if (!steps.length) return undefined
  return {
    steps: steps.map((s) => ({
      prompt: s.prompt,
      reply: s.reply,
      stages: toPipeline(s.cards).stages,
      changes: s.changes,
    })),
  }
}

/** The steps of a saved pipeline, as the builder keeps them. */
export function stepsFrom(assistant: PipelineAssistant | undefined): AssistantStep[] {
  return (assistant?.steps ?? []).map((s) => ({
    prompt: s.prompt,
    reply: s.reply,
    changes: s.changes,
    cards: cardsFromStages(s.stages).cards,
  }))
}
