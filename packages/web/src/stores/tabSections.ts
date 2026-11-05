// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * Phase 3e-1: the open section of database and connection tabs, kept with the tab (as collection
 * tabs keep theirs in collectionViews), so the palette can switch it and switching tabs keeps it.
 */
export const useTabSectionsStore = defineStore('tabSections', () => {
  const sections = ref<Record<string, string>>({})
  const get = (tabId: string, fallback: string): string => sections.value[tabId] ?? fallback
  function set(tabId: string, section: string): void {
    sections.value = { ...sections.value, [tabId]: section }
  }
  /**
   * Review of the Monitoring redesign (minor): a tab's other choices kept with it (Performance's time
   * span), under `<tab id>#<name>` so they leave with the tab.
   */
  const getValue = (tabId: string, name: string, fallback: string): string =>
    sections.value[`${tabId}#${name}`] ?? fallback
  function setValue(tabId: string, name: string, value: string): void {
    set(`${tabId}#${name}`, value)
  }
  function prune(liveTabIds: ReadonlySet<string>): void {
    for (const id of Object.keys(sections.value))
      if (!liveTabIds.has(id.split('#')[0]!)) delete sections.value[id]
  }
  function reset(): void {
    sections.value = {}
  }
  return { sections, get, set, getValue, setValue, prune, reset }
})
