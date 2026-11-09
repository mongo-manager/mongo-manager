// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { backupApi } from '../src/api/backup'
import { useDumpPlan } from '../src/backup/useDumpPlan'
import { useRestorePlan } from '../src/backup/useRestorePlan'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Runs a composable inside a mounted component and hands back what it returned. */
function host<T>(use: () => T): T {
  let out!: T
  mount(
    defineComponent({
      setup() {
        out = use()
        return () => h('div')
      },
    }),
  )
  return out
}

describe('useDumpPlan', () => {
  // Phase 3d-3b e2e: a choice made while a plan was on its way let Start use that stale plan (409).
  it('ignores a plan answered for settings that changed while it was on its way', async () => {
    vi.useFakeTimers()
    const answers: Array<(v: unknown) => void> = []
    const sent: object[] = []
    vi.spyOn(backupApi, 'dumpPlan').mockImplementation((_c, body) => {
      sent.push(structuredClone(body))
      return new Promise((resolve) => answers.push(resolve as (v: unknown) => void)) as never
    })
    const s = reactive({ deleteLocal: false })
    const api = host(() =>
      useDumpPlan(
        'c1',
        computed(() => ({ deleteLocal: s.deleteLocal })),
      ),
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(sent).toEqual([{ deleteLocal: false }])

    // The user changes a setting before the first answer arrives.
    s.deleteLocal = true
    await vi.advanceTimersByTimeAsync(0)
    expect(api.loading.value).toBe(true)
    answers[0]!({ planHash: 'old', refusals: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.loading.value).toBe(true)
    expect(api.plan.value).toBeNull()

    await vi.advanceTimersByTimeAsync(300)
    expect(sent.at(-1)).toEqual({ deleteLocal: true })
    answers.at(-1)!({ planHash: 'new', refusals: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.loading.value).toBe(false)
    expect(api.plan.value).toEqual({ planHash: 'new', refusals: [] })
  })
})

describe('useRestorePlan', () => {
  it('ignores a plan answered for settings that changed while it was on its way', async () => {
    vi.useFakeTimers()
    const answers: Array<(v: unknown) => void> = []
    vi.spyOn(backupApi, 'restorePlan').mockImplementation(
      () => new Promise((resolve) => answers.push(resolve as (v: unknown) => void)) as never,
    )
    const s = reactive({ mode: 'merge' })
    const api = host(() =>
      useRestorePlan(
        ref('c1'),
        computed(() => ({ mode: s.mode })),
      ),
    )
    await vi.advanceTimersByTimeAsync(300)
    s.mode = 'replace'
    await vi.advanceTimersByTimeAsync(0)
    answers[0]!({ planHash: 'old' })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.loading.value).toBe(true)
    expect(api.plan.value).toBeNull()
    await vi.advanceTimersByTimeAsync(300)
    answers.at(-1)!({ planHash: 'new' })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.loading.value).toBe(false)
    expect(api.plan.value).toEqual({ planHash: 'new' })
  })
})
