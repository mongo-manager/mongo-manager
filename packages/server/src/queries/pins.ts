// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MAX_LIBRARY_PINS, PINNABLE_TYPES, type LibraryPin } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { PreferencesRepo } from '../store/preferences'

/**
 * W1 (completion §2): the saved queries a user pinned on a connection — their own preference, kept
 * with the others (the users route removes them with the user). Ids only: what a pin names is checked
 * against what the user may see each time it is listed or pinned.
 */
export type PinnedType = (typeof PINNABLE_TYPES)[number]
export interface PinRef {
  type: PinnedType
  id: string
}

const keyOf = (connectionId: string) => `library-pins:${connectionId}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The pins kept, newest last; anything that is not a pin is left out (a value from elsewhere). */
export function pinsOf(prefs: PreferencesRepo, owner: string, connectionId: string): PinRef[] {
  const stored = prefs.get(owner, keyOf(connectionId))
  const list = Array.isArray((stored as { items?: unknown } | null)?.items)
    ? ((stored as { items: unknown[] }).items as unknown[])
    : []
  return list
    .filter(
      (p): p is PinRef =>
        !!p &&
        typeof p === 'object' &&
        (PINNABLE_TYPES as readonly string[]).includes((p as PinRef).type) &&
        typeof (p as PinRef).id === 'string' &&
        UUID.test((p as PinRef).id),
    )
    .slice(-MAX_LIBRARY_PINS)
}

/**
 * Pins or unpins one saved query. `counts` says whether a pinned query still counts: pins of queries
 * deleted, or no longer visible to the user (W1 review, minor 1), are forgotten before the limit is
 * counted, so they never hold a place.
 */
export function setPin(
  prefs: PreferencesRepo,
  owner: string,
  connectionId: string,
  pin: LibraryPin,
  counts: (ref: PinRef) => boolean,
): void {
  const others = pinsOf(prefs, owner, connectionId).filter((p) => !(p.type === pin.type && p.id === pin.id))
  let items = others
  if (pin.pinned) {
    items = others.filter(counts)
    if (items.length >= MAX_LIBRARY_PINS)
      throw Errors.conflict(`At most ${MAX_LIBRARY_PINS} queries can be pinned on a connection`, {
        reason: 'limit',
        max: MAX_LIBRARY_PINS,
      })
    items = [...items, { type: pin.type, id: pin.id }]
  }
  if (items.length) prefs.set(owner, keyOf(connectionId), { items })
  else prefs.remove(owner, keyOf(connectionId))
}

/** W1 review (minor 2): a deleted connection's pins, every user's. */
export function forgetConnectionPins(prefs: PreferencesRepo, connectionId: string): void {
  prefs.removeKeyForAll(keyOf(connectionId))
}
