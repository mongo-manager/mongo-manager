// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
const UNITS = {
  en: { h: 'h', min: 'min', s: 's' },
  tr: { h: 'sa', min: 'dk', s: 'sn' },
} as const

/** Review of the languages (I1): the other languages' units, as Intl writes them short. */
const unit = (n: number, u: 'second' | 'minute' | 'hour', locale: string) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(n)

/** "12 s", "3 min 12 s", "2 h 5 min" (TR: "12 sn", "3 dk 12 sn", "2 sa 5 dk"); Intl's elsewhere. */
export function formatElapsed(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (!locale.startsWith('tr') && !locale.startsWith('en')) {
    if (hours > 0) return `${unit(hours, 'hour', locale)} ${unit(minutes, 'minute', locale)}`
    if (minutes > 0) return `${unit(minutes, 'minute', locale)} ${unit(seconds, 'second', locale)}`
    return unit(seconds, 'second', locale)
  }
  const u = locale.startsWith('tr') ? UNITS.tr : UNITS.en
  if (hours > 0) return `${hours} ${u.h} ${minutes} ${u.min}`
  if (minutes > 0) return `${minutes} ${u.min} ${seconds} ${u.s}`
  return `${seconds} ${u.s}`
}
