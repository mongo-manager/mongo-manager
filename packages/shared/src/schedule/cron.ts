// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { CronFieldName, CronProblemCode } from '../api/schedules'
import { isoWeekday, type CivilDate } from './zone'

/** Phase 3d-3c spec §1.3: an expression this server refuses, and the field at fault (null: the whole). */
export class CronError extends Error {
  override name = 'CronError'
  constructor(
    readonly field: CronFieldName | null,
    message: string,
    /** Final review minor 2: what went wrong and its values, for the reader's own language. */
    readonly code: CronProblemCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message)
  }
}

/** Five fields, Vixie semantics (plan ruling 5). */
export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  /** 0 Sunday … 6 Saturday (7 is read as 0). */
  daysOfWeek: number[]
  /** A day field written from "*" (also "*\/2") does not restrict: the other day field alone decides. */
  domStar: boolean
  dowStar: boolean
}

interface FieldDef {
  name: CronFieldName
  min: number
  max: number
  names?: readonly string[]
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
const FIELDS: readonly FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'dayOfWeek', min: 0, max: 7, names: DAYS },
]
/** D8: bounded input. */
export const MAX_CRON_LENGTH = 200
export const MAX_CRON_ITEMS = 60
/** "*", a value or a name, or a range, each with an optional step. Nothing else (no L, W, # or ?). */
const ITEM = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/

function value(text: string, f: FieldDef): number {
  const named = f.names?.indexOf(text.toUpperCase()) ?? -1
  if (named >= 0) return named + (f.name === 'month' ? 1 : 0)
  if (!/^\d{1,2}$/.test(text))
    throw new CronError(
      f.name,
      `"${text}" is not a number${f.names ? ' or a name' : ''} of this field`,
      f.names ? 'not_name_or_number' : 'not_number',
      { text },
    )
  const n = Number(text)
  if (n < f.min || n > f.max)
    throw new CronError(f.name, `${n} is outside ${f.min}–${f.max}`, 'out_of_range', {
      n,
      min: f.min,
      max: f.max,
    })
  return n
}

function field(text: string, f: FieldDef): number[] {
  const items = text.split(',')
  if (items.length > MAX_CRON_ITEMS)
    throw new CronError(f.name, `At most ${MAX_CRON_ITEMS} items in a list`, 'too_many', {
      max: MAX_CRON_ITEMS,
    })
  const out = new Set<number>()
  for (const item of items) {
    const m = ITEM.exec(item)
    if (!m) throw new CronError(f.name, `"${item}" is not a value, a range or a step`, 'not_item', { item })
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (step < 1 || step > f.max)
      throw new CronError(f.name, `The step ${m[2]} is outside 1–${f.max}`, 'bad_step', {
        step: m[2]!,
        max: f.max,
      })
    let lo: number
    let hi: number
    if (m[1] === '*') [lo, hi] = [f.min, f.max]
    else if (m[1]!.includes('-')) {
      const [a, b] = m[1]!.split('-')
      lo = value(a!, f)
      hi = value(b!, f)
      if (lo > hi)
        throw new CronError(f.name, `The range ${m[1]} runs backwards`, 'backwards', { range: m[1]! })
    } else {
      lo = value(m[1]!, f)
      // "5/15": from 5 to the end, every 15 (a Vixie extension).
      hi = m[2] === undefined ? lo : f.max
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

/** Spec §1.3: five fields, `*`, lists, ranges, steps and names; no seconds and no `@` shortcuts. */
export function parseCron(expression: string): CronSpec {
  if (typeof expression !== 'string' || expression.length > MAX_CRON_LENGTH)
    throw new CronError(null, `A cron expression has at most ${MAX_CRON_LENGTH} characters`, 'too_long', {
      max: MAX_CRON_LENGTH,
    })
  const text = expression.trim()
  if (text.startsWith('@'))
    throw new CronError(
      null,
      'Shortcuts such as @daily or @reboot are not supported; write the five fields',
      'shortcut',
    )
  const parts = text.split(/\s+/)
  if (parts.length !== 5)
    throw new CronError(
      null,
      'A cron expression has five fields: minute hour day-of-month month day-of-week',
      'fields',
    )
  const sets = parts.map((p, i) => field(p, FIELDS[i]!))
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek: [...new Set(sets[4]!.map((d) => d % 7))].sort((a, b) => a - b),
    domStar: parts[2]!.startsWith('*'),
    dowStar: parts[4]!.startsWith('*'),
  }
}

/** Whether a calendar day matches: the month, then day of month OR day of week (Vixie cron). */
export function cronDay(spec: CronSpec, d: CivilDate): boolean {
  if (!spec.months.includes(d.month)) return false
  const dom = spec.daysOfMonth.includes(d.day)
  const dow = spec.daysOfWeek.includes(isoWeekday(d) % 7)
  return spec.domStar || spec.dowStar ? dom && dow : dom || dow
}
