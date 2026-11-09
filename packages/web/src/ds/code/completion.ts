// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export interface Completion {
  label: string
  kind: 'operator' | 'field' | 'constructor' | 'method' | 'collection' | 'command' | 'value'
  /** Text inserted instead of the label (defaults to the label). */
  insert?: string
}

/** An answer of an async completion provider: the items, replacing from `from` to the caret. */
export interface CompletionResult {
  from: number
  items: Completion[]
}
