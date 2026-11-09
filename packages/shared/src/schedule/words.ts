// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { UiLanguage } from '../languages'

/**
 * Languages (2026-10-29): a cadence in words for the languages after English and Turkish (those
 * two keep their own sentences in describe.ts). Each language puts the parts in its own order; day
 * and month names come from Intl. Russian names days and months as a list ("дни недели: …"), so no
 * noun has to be declined.
 */
export type OtherLanguage = Exclude<UiLanguage, 'en' | 'tr'>

export interface CronParts {
  /** Every hour of the day. */
  allHours: boolean
  /** Six times a day or fewer: the times are listed. */
  few: boolean
  times: string[]
  minutes: string[]
  hours: string[]
  /** Days of the month, when restricted; several when more than one is named. */
  dom: string[] | null
  domMany: boolean
  /**
   * Days of the week in words, when restricted. With days of the month too, either matches: cron's
   * rule when neither is * (the only way both are restricted).
   */
  days: string | null
  months: string[] | null
}

export interface Words {
  list(items: string[]): string
  range(from: string, to: string): string
  hourly(minute: number): string
  everyHoursAt(every: number, times: string[]): string
  everyHoursMinute(every: number, minute: number): string
  daily(times: string[]): string
  weekly(days: string, time: string): string
  monthlyLast(time: string): string
  monthly(day: number, time: string): string
  cron(p: CronParts): string
}

const joined = (sep: string, last: string) => (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(sep)}${last}${items.at(-1)}`

const zhList = (items: string[]) => items.join('、')
const zh: Words = {
  list: zhList,
  range: (a, b) => `${a}至${b}`,
  hourly: (m) => `每小时第 ${m} 分钟`,
  everyHoursAt: (n, t) => `每 ${n} 小时，于 ${zhList(t)}`,
  everyHoursMinute: (n, m) => `每 ${n} 小时，第 ${m} 分钟`,
  daily: (t) => `每天 ${zhList(t)}`,
  weekly: (d, t) => `每${d} ${t}`,
  monthlyLast: (t) => `每月最后一天 ${t}`,
  monthly: (d, t) => `每月 ${d} 日 ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `每小时第 ${zhList(p.minutes)} 分钟`
      : p.few
        ? zhList(p.times)
        : `${zhList(p.hours)} 时的第 ${zhList(p.minutes)} 分钟`
    const dom = p.dom && `每月 ${zhList(p.dom)} 日`
    const day = dom && p.days ? `${dom}或每${p.days}` : (dom ?? (p.days && `每${p.days}`))
    const parts = [p.months && zhList(p.months), day || (!p.months && !p.allHours ? '每天' : null), time]
    return parts.filter(Boolean).join(' ')
  },
}

const jaList = (items: string[]) => items.join('、')
const ja: Words = {
  list: jaList,
  range: (a, b) => `${a}〜${b}`,
  hourly: (m) => `毎時 ${m} 分`,
  everyHoursAt: (n, t) => `${n} 時間ごと（${jaList(t)}）`,
  everyHoursMinute: (n, m) => `${n} 時間ごとの ${m} 分`,
  daily: (t) => `毎日 ${jaList(t)}`,
  weekly: (d, t) => `毎週${d} ${t}`,
  monthlyLast: (t) => `毎月末日 ${t}`,
  monthly: (d, t) => `毎月 ${d} 日 ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `毎時 ${jaList(p.minutes)} 分`
      : p.few
        ? jaList(p.times)
        : `${jaList(p.hours)} 時の ${jaList(p.minutes)} 分`
    const dom = p.dom && `毎月 ${jaList(p.dom)} 日`
    const day = dom && p.days ? `${dom}または毎週${p.days}` : (dom ?? (p.days && `毎週${p.days}`))
    const parts = [p.months && jaList(p.months), day || (!p.months && !p.allHours ? '毎日' : null), time]
    return parts.filter(Boolean).join(' ')
  },
}

const koList = (items: string[]) => items.join(', ')
const ko: Words = {
  list: koList,
  range: (a, b) => `${a}~${b}`,
  hourly: (m) => `매시 ${m}분`,
  everyHoursAt: (n, t) => `${n}시간마다 (${koList(t)})`,
  everyHoursMinute: (n, m) => `${n}시간마다 ${m}분`,
  daily: (t) => `매일 ${koList(t)}`,
  weekly: (d, t) => `매주 ${d} ${t}`,
  monthlyLast: (t) => `매월 마지막 날 ${t}`,
  monthly: (d, t) => `매월 ${d}일 ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `매시 ${koList(p.minutes)}분`
      : p.few
        ? koList(p.times)
        : `${koList(p.hours)}시 ${koList(p.minutes)}분`
    const dom = p.dom && `매월 ${koList(p.dom)}일`
    const day = dom && p.days ? `${dom} 또는 매주 ${p.days}` : (dom ?? (p.days && `매주 ${p.days}`))
    const parts = [p.months && koList(p.months), day || (!p.months && !p.allHours ? '매일' : null), time]
    return parts.filter(Boolean).join(' ')
  },
}

const esList = joined(', ', ' y ')
/** "a las 02:00", but "a la 01:00". */
const esAt = (t: string[]) =>
  t.length === 1 && t[0]!.startsWith('01:') ? `a la ${t[0]}` : `a las ${esList(t)}`
const es: Words = {
  list: esList,
  range: (a, b) => `de ${a} a ${b}`,
  hourly: (m) => `Cada hora en el minuto ${m}`,
  everyHoursAt: (n, t) => `Cada ${n} horas, ${esAt(t)}`,
  everyHoursMinute: (n, m) => `Cada ${n} horas en el minuto ${m}`,
  daily: (t) => `Todos los días ${esAt(t)}`,
  weekly: (d, t) => `Cada semana: ${d}, ${esAt([t])}`,
  monthlyLast: (t) => `El último día de cada mes ${esAt([t])}`,
  monthly: (d, t) => `El día ${d} de cada mes ${esAt([t])}`,
  cron: (p) => {
    const time = p.allHours
      ? `En el minuto ${esList(p.minutes)} de cada hora`
      : p.few
        ? esAt(p.times).replace(/^a/, 'A')
        : `En el minuto ${esList(p.minutes)} de las horas ${esList(p.hours)}`
    const dom = p.dom && `${p.domMany ? 'los días' : 'el día'} ${esList(p.dom)} del mes`
    const day = dom && p.days ? `${dom} o si es ${p.days}` : (dom ?? p.days)
    const parts = [
      time,
      day,
      p.months && `en ${esList(p.months)}`,
      !day && !p.months && !p.allHours ? 'todos los días' : null,
    ]
    return parts.filter(Boolean).join(', ')
  },
}

const ptList = joined(', ', ' e ')
const pt: Words = {
  list: ptList,
  range: (a, b) => `de ${a} a ${b}`,
  hourly: (m) => `A cada hora, no minuto ${m}`,
  everyHoursAt: (n, t) => `A cada ${n} horas, às ${ptList(t)}`,
  everyHoursMinute: (n, m) => `A cada ${n} horas, no minuto ${m}`,
  daily: (t) => `Todos os dias às ${ptList(t)}`,
  weekly: (d, t) => `Toda semana: ${d}, às ${t}`,
  monthlyLast: (t) => `No último dia de cada mês às ${t}`,
  monthly: (d, t) => `No dia ${d} de cada mês às ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `No minuto ${ptList(p.minutes)} de cada hora`
      : p.few
        ? `Às ${ptList(p.times)}`
        : `No minuto ${ptList(p.minutes)} das horas ${ptList(p.hours)}`
    const dom = p.dom && `${p.domMany ? 'nos dias' : 'no dia'} ${ptList(p.dom)} do mês`
    const day = dom && p.days ? `${dom} ou se for ${p.days}` : (dom ?? p.days)
    const parts = [
      time,
      day,
      p.months && `em ${ptList(p.months)}`,
      !day && !p.months && !p.allHours ? 'todos os dias' : null,
    ]
    return parts.filter(Boolean).join(', ')
  },
}

const deList = joined(', ', ' und ')
const de: Words = {
  list: deList,
  range: (a, b) => `${a} bis ${b}`,
  hourly: (m) => `Jede Stunde zur Minute ${m}`,
  everyHoursAt: (n, t) => `Alle ${n} Stunden, um ${deList(t)}`,
  everyHoursMinute: (n, m) => `Alle ${n} Stunden zur Minute ${m}`,
  daily: (t) => `Täglich um ${deList(t)}`,
  weekly: (d, t) => `Wöchentlich: ${d}, um ${t}`,
  monthlyLast: (t) => `Am letzten Tag jedes Monats um ${t}`,
  monthly: (d, t) => `Am ${d}. jedes Monats um ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `Zur Minute ${deList(p.minutes)} jeder Stunde`
      : p.few
        ? `Um ${deList(p.times)}`
        : `Zur Minute ${deList(p.minutes)} der Stunden ${deList(p.hours)}`
    const dom =
      p.dom && (p.domMany ? `an den Tagen ${deList(p.dom)} des Monats` : `am ${p.dom[0]}. des Monats`)
    const day = dom && p.days ? `${dom} oder wenn es ${p.days} ist` : (dom ?? p.days)
    const parts = [
      time,
      day,
      p.months && `im ${deList(p.months)}`,
      !day && !p.months && !p.allHours ? 'täglich' : null,
    ]
    return parts.filter(Boolean).join(', ')
  },
}

const frList = joined(', ', ' et ')
/** The first of the month is "1er". */
const frDay = (d: string) => (d === '1' ? '1er' : d)
const fr: Words = {
  list: frList,
  range: (a, b) => `du ${a} au ${b}`,
  hourly: (m) => `Toutes les heures à la minute ${m}`,
  everyHoursAt: (n, t) => `Toutes les ${n} heures, à ${frList(t)}`,
  everyHoursMinute: (n, m) => `Toutes les ${n} heures à la minute ${m}`,
  daily: (t) => `Tous les jours à ${frList(t)}`,
  weekly: (d, t) => `Chaque semaine : ${d}, à ${t}`,
  monthlyLast: (t) => `Le dernier jour de chaque mois à ${t}`,
  monthly: (d, t) => `Le ${frDay(String(d))} de chaque mois à ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `À la minute ${frList(p.minutes)} de chaque heure`
      : p.few
        ? `À ${frList(p.times)}`
        : `À la minute ${frList(p.minutes)} des heures ${frList(p.hours)}`
    const dom = p.dom && `${p.domMany ? 'les' : 'le'} ${frList(p.dom.map(frDay))} du mois`
    const day =
      dom && p.days ? `${dom} ou ${p.days.startsWith('du ') ? p.days : `le ${p.days}`}` : (dom ?? p.days)
    const parts = [
      time,
      day,
      p.months && `en ${frList(p.months)}`,
      !day && !p.months && !p.allHours ? 'tous les jours' : null,
    ]
    return parts.filter(Boolean).join(', ')
  },
}

const ruList = joined(', ', ' и ')
const ru: Words = {
  list: ruList,
  range: (a, b) => `${a}–${b}`,
  hourly: (m) => `Каждый час в ${m} мин`,
  everyHoursAt: (n, t) => `Каждые ${n} ч, в ${ruList(t)}`,
  everyHoursMinute: (n, m) => `Каждые ${n} ч, в ${m} мин`,
  daily: (t) => `Ежедневно в ${ruList(t)}`,
  weekly: (d, t) => `Еженедельно: ${d}, в ${t}`,
  monthlyLast: (t) => `В последний день каждого месяца в ${t}`,
  monthly: (d, t) => `${d}-го числа каждого месяца в ${t}`,
  cron: (p) => {
    const time = p.allHours
      ? `В ${ruList(p.minutes)} мин каждого часа`
      : p.few
        ? `В ${ruList(p.times)}`
        : `В ${ruList(p.minutes)} мин, часы: ${ruList(p.hours)}`
    const dom = p.dom && `числа месяца: ${ruList(p.dom)}`
    const days = p.days && `дни недели: ${p.days}`
    const day = dom && days ? `${dom} или ${days}` : (dom ?? days)
    const parts = [
      time,
      day,
      p.months && `месяцы: ${ruList(p.months)}`,
      !day && !p.months && !p.allHours ? 'ежедневно' : null,
    ]
    return parts.filter(Boolean).join(', ')
  },
}

export const WORDS: Record<OtherLanguage, Words> = { zh, ja, es, pt, ko, de, fr, ru }
