// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER

/**
 * Document page design §6.6: one undo history for the tree and the text. Each tree edit is a step;
 * typing becomes a step at each pause. Undo in either view takes back the last step of either.
 */
export const HISTORY_STEPS = 200
/**
 * Final review I2: the characters all steps may hold together (each holds the whole text): a
 * document of a few MB keeps fewer steps instead of hundreds of MB.
 */
export const HISTORY_CHARS = 20_000_000

export interface DraftHistory {
  /** Typing: joins the last typed step when it came within the grouping time. */
  push(text: string, now?: number): void
  /** A tree edit: always a step of its own. */
  pushStep(text: string): void
  undo(): string | null
  redo(): string | null
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export function createHistory(initial: string, groupMs = 500, maxChars = HISTORY_CHARS): DraftHistory {
  const steps = [initial]
  let at = 0
  let chars = initial.length
  /** When the last step came from typing, the time it was last typed into; else null. */
  let typedAt: number | null = null

  const add = (text: string): void => {
    for (const dropped of steps.splice(at + 1)) chars -= dropped.length
    steps.push(text)
    chars += text.length
    while (steps.length > 1 && (steps.length > HISTORY_STEPS + 1 || chars > maxChars))
      chars -= steps.shift()!.length
    at = steps.length - 1
  }

  return {
    push(text, now = Date.now()) {
      if (text === steps[at]) return
      if (typedAt !== null && at === steps.length - 1 && at > 0 && now - typedAt <= groupMs) {
        chars += text.length - steps[at]!.length
        steps[at] = text
      } else add(text)
      typedAt = now
    },
    pushStep(text) {
      typedAt = null
      if (text !== steps[at]) add(text)
    },
    undo() {
      typedAt = null
      if (at === 0) return null
      return steps[--at]!
    },
    redo() {
      typedAt = null
      if (at === steps.length - 1) return null
      return steps[++at]!
    },
    get canUndo() {
      return at > 0
    },
    get canRedo() {
      return at < steps.length - 1
    },
  }
}
