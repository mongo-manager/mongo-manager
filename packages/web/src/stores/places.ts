// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { WorkspaceTab } from './tabs'

/**
 * UI redesign R1 revision 2 §3.6: places the user pinned, and the places they opened last. Per user,
 * in local storage, with ids and names only — never documents, queries or secrets.
 */
export type PlaceKind = 'connection' | 'database' | 'collection'
export interface Place {
  key: string
  kind: PlaceKind
  title: string
  params: Record<string, string>
}

const KINDS: readonly PlaceKind[] = ['connection', 'database', 'collection']
const MAX_RECENT = 12
const MAX_PINS = 50
const MAX_TITLE = 200

function validPlace(p: unknown): p is Place {
  const place = p as Partial<Place> | null
  if (!place || typeof place !== 'object') return false
  if (typeof place.key !== 'string' || typeof place.title !== 'string') return false
  if (!KINDS.includes(place.kind as PlaceKind)) return false
  const params = place.params as Record<string, unknown> | undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false
  if (!Object.values(params).every((v) => typeof v === 'string')) return false
  return typeof params.connectionId === 'string' && params.connectionId !== ''
}

function read(key: string): Place[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(validPlace).map((p) => ({ ...p, title: p.title.slice(0, MAX_TITLE) }))
      : []
  } catch {
    return []
  }
}
function write(key: string, places: Place[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(places))
  } catch {
    // storage blocked: places are simply not remembered
  }
}

export const connectionPlace = (c: { id: string; name: string }): Place => ({
  key: `connection:${c.id}`,
  kind: 'connection',
  title: c.name,
  params: { connectionId: c.id },
})
export const databasePlace = (connectionId: string, db: string): Place => ({
  key: `database:${connectionId}/${db}`,
  kind: 'database',
  title: db,
  params: { connectionId, db },
})
export const collectionPlace = (connectionId: string, db: string, coll: string): Place => ({
  key: `collection:${connectionId}/${db}/${coll}`,
  kind: 'collection',
  title: `${db}.${coll}`,
  params: { connectionId, db, coll },
})

/** The place a tab shows, or null for tabs that are not a connection, database or collection. */
export function placeOfTab(tab: WorkspaceTab | null | undefined): Place | null {
  const p = tab?.params
  if (!tab || !p?.connectionId) return null
  if (tab.kind === 'collection' && p.db && p.coll) return collectionPlace(p.connectionId, p.db, p.coll)
  if (tab.kind === 'database' && p.db) return databasePlace(p.connectionId, p.db)
  if (tab.kind === 'connection') return connectionPlace({ id: p.connectionId, name: tab.title })
  return null
}

export const usePlacesStore = defineStore('places', () => {
  const pins = ref<Place[]>([])
  const recent = ref<Place[]>([])
  let owner: string | null = null
  const pinsKey = () => `mm:pins:${owner}`
  const recentKey = () => `mm:recent:${owner}`

  /** Places belong to one user: binding loads theirs, and nothing is stored before. */
  function bindUser(userId: string): void {
    if (owner === userId) return
    owner = userId
    pins.value = read(pinsKey())
    recent.value = read(recentKey())
  }

  const isPinned = (key: string) => pins.value.some((p) => p.key === key)

  function pin(place: Place): void {
    if (isPinned(place.key)) return
    pins.value = [...pins.value, place].slice(-MAX_PINS)
    if (owner) write(pinsKey(), pins.value)
  }
  function unpin(key: string): void {
    pins.value = pins.value.filter((p) => p.key !== key)
    if (owner) write(pinsKey(), pins.value)
  }
  function togglePin(place: Place): void {
    if (isPinned(place.key)) unpin(place.key)
    else pin(place)
  }

  function visit(place: Place): void {
    recent.value = [place, ...recent.value.filter((p) => p.key !== place.key)].slice(0, MAX_RECENT)
    if (owner) write(recentKey(), recent.value)
  }

  /** User request 2026-10-10: the places opened last, forgotten on request; pins stay. */
  function clearRecent(): void {
    recent.value = []
    if (owner) write(recentKey(), [])
  }

  /** Sign-out: recent places go with the tabs; pins are the user's choice and stay theirs. */
  function reset(): void {
    if (owner) {
      try {
        localStorage.removeItem(recentKey())
      } catch {
        // storage blocked: nothing stored anyway
      }
    }
    pins.value = []
    recent.value = []
    owner = null
  }

  return { pins, recent, bindUser, isPinned, pin, unpin, togglePin, visit, clearRecent, reset }
})
