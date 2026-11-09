// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ConnectionColor } from '@mongo-manager/shared'

/**
 * A connection's own colour, chosen by its user to tell it apart: a fixed categorical palette (Tailwind's
 * own steps), the same in every theme and accent — not the interface's tokens.
 */
export const COLOR_CLASSES: Record<ConnectionColor, string> = {
  gray: 'bg-slate-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
}
