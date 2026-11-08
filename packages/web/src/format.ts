// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Binary sizes (1 KB = 1024 B), localised decimal separator. */
export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** i
  const digits = i === 0 ? 0 : value < 10 ? 2 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${UNITS[i]}`
}

export const formatCount = (n: number, locale: string): string => new Intl.NumberFormat(locale).format(n)

/** "2 min", "30 sec", "1 hr 5 min": a short duration in the locale's words. */
export function formatDuration(seconds: number, locale: string): string {
  const unit = (n: number, u: 'second' | 'minute' | 'hour') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(n)
  if (seconds < 60) return unit(Math.max(1, Math.round(seconds)), 'second')
  if (seconds < 3600) return unit(Math.round(seconds / 60), 'minute')
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour')
}

/** "3 hours ago", "in 21 hours": `ms` from now (negative: in the past). */
export function formatRelative(ms: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const s = Math.round(ms / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}
