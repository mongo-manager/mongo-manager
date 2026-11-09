// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * Review 2026-10-11: work a tab would lose when closed (a SQL dump read and not yet imported, an
 * import running): closing it asks first, and so does the browser when the page is left.
 */
export const useTabWorkStore = defineStore('tabWork', () => {
  const busy = ref(new Set<string>())
  function set(id: string, on: boolean): void {
    if (busy.value.has(id) === on) return
    const next = new Set(busy.value)
    if (on) next.add(id)
    else next.delete(id)
    busy.value = next
  }
  const has = (id: string) => busy.value.has(id)
  const any = () => busy.value.size > 0
  return { set, has, any }
})
