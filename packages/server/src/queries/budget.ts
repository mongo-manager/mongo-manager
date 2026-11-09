// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 2c (final review, I2b): how many sealed bytes a search may still open. Shared by the
 * sources of one search; a row that would go over it is left unopened and the search says so.
 */
export interface ByteBudget {
  left: number
  exhausted: boolean
}

/** Takes `bytes` from the budget, or marks it exhausted and answers false. */
export function spend(budget: ByteBudget | undefined, bytes: number): boolean {
  if (!budget) return true
  if (budget.exhausted || bytes > budget.left) {
    budget.exhausted = true
    return false
  }
  budget.left -= bytes
  return true
}
