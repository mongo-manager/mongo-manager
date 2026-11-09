// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * Review 2026-10-11: the jobs a page shows in sight, how they end said there — no toast besides.
 * A job out of sight (its part or tab not shown, its panel gone) is announced as any other.
 */
const shown = new Set<string>()

export const isJobShown = (id: string) => shown.has(id)

/** Registers the job a panel shows while it is in sight. */
export function useShownJob(job: Ref<string | null>, inSight: Ref<boolean>): void {
  let current: string | null = null
  const release = () => {
    if (current) shown.delete(current)
    current = null
  }
  watch(
    [job, inSight],
    ([id, visible]) => {
      release()
      if (id && visible) {
        shown.add(id)
        current = id
      }
    },
    { immediate: true, flush: 'sync' },
  )
  onBeforeUnmount(release)
}
