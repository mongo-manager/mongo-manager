// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  MAX_COMMAND_BYTES,
  MAX_COMPLETION_BYTES,
  MAX_COMPLETIONS,
  ShellToWorker,
  WorkerToShell,
} from '../src/shell/ipc'

/** Phase 3a-2 spec §3.2 (A1): the completion messages are bounded like eval's. */
describe('completion IPC schemas', () => {
  it('accepts a bounded completion request and reply', () => {
    expect(ShellToWorker.safeParse({ type: 'complete', id: 1, code: 'db.' }).success).toBe(true)
    expect(WorkerToShell.safeParse({ type: 'completions', id: 1, items: ['db.orders'] }).success).toBe(true)
  })

  it('refuses more than 200 items', () => {
    const items = Array.from({ length: MAX_COMPLETIONS + 1 }, (_, i) => `db.c${i}`)
    expect(WorkerToShell.safeParse({ type: 'completions', id: 1, items }).success).toBe(false)
  })

  it('measures an item in bytes, not characters', () => {
    const item = '€'.repeat(171) // 171 characters, 513 bytes
    expect(item.length).toBeLessThan(MAX_COMPLETION_BYTES)
    expect(WorkerToShell.safeParse({ type: 'completions', id: 1, items: [item] }).success).toBe(false)
    expect(WorkerToShell.safeParse({ type: 'completions', id: 1, items: ['€'.repeat(170)] }).success).toBe(
      true,
    )
  })

  it('refuses a request over the command size and unknown fields', () => {
    expect(
      ShellToWorker.safeParse({ type: 'complete', id: 1, code: 'x'.repeat(MAX_COMMAND_BYTES + 1) }).success,
    ).toBe(false)
    expect(ShellToWorker.safeParse({ type: 'complete', id: 1, code: 'db.', extra: 1 }).success).toBe(false)
    expect(WorkerToShell.safeParse({ type: 'completions', id: 1, items: [], extra: 1 }).success).toBe(false)
  })
})
