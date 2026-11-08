// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** A box's place in a data model's diagram. */
export interface Place {
  x: number
  y: number
}

/**
 * 2026-10-26 (user report; review M4): where the user put a database's boxes, by name, kept for the
 * session — not with the Model section, which is drawn again each time it is opened.
 */
export const useModelPlacesStore = defineStore('modelPlaces', () => {
  const byDatabase = ref<Record<string, Record<string, Place>>>({})
  const keyOf = (connectionId: string, db: string) => JSON.stringify([connectionId, db])
  const of = (connectionId: string, db: string): Record<string, Place> =>
    byDatabase.value[keyOf(connectionId, db)] ?? {}
  function put(connectionId: string, db: string, name: string, place: Place): void {
    const key = keyOf(connectionId, db)
    byDatabase.value = { ...byDatabase.value, [key]: { ...of(connectionId, db), [name]: place } }
  }
  function clear(connectionId: string, db: string): void {
    const { [keyOf(connectionId, db)]: _gone, ...rest } = byDatabase.value
    byDatabase.value = rest
  }
  /** Another user may sign in next. */
  function reset(): void {
    byDatabase.value = {}
  }
  return { of, put, clear, reset }
})
