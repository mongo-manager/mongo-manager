// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 3 (spec §3): a seeded random source (mulberry32): the same seed gives the same
 * documents, so a test set can be made again.
 */
export interface Rand {
  /** A number in [0, 1). */
  next(): number
  /** An integer in [min, max]. */
  int(min: number, max: number): number
  /** One of the items. */
  pick<T>(items: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
}

export function rand(seed: number): Rand {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  }
}
