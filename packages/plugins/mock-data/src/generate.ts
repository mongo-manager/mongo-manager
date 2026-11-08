// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { DE, ES, FR, JA, KO, PT, RU, ZH } from './data/extra'
import { EN, TR, type Lists } from './data/lists'
import type { FieldPlan } from './plan'
import { rand } from './prng'
import { templateOf } from './templates'

/**
 * Plugins wave 3 (spec §3): test documents made from the plans — as many as asked, a share of
 * fields left out, in the words of any of the app's ten languages, the same for the same seed. An array of objects
 * (`items[].qty`) gets one to three elements. Canonical Extended JSON, one document a line.
 */
/** The languages the words can be in: the app's languages the plugin has word lists for. */
export const DATA_LANGUAGES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
export type DataLanguage = (typeof DATA_LANGUAGES)[number]
const LISTS: Record<DataLanguage, Lists> = {
  en: EN,
  tr: TR,
  zh: ZH,
  ja: JA,
  es: ES,
  pt: PT,
  ko: KO,
  de: DE,
  fr: FR,
  ru: RU,
}
/** The data language for a reader's language: theirs when there are words in it, else English. */
export const dataLanguageOf = (locale: string): DataLanguage =>
  (DATA_LANGUAGES as readonly string[]).includes(locale) ? (locale as DataLanguage) : 'en'

export const MAX_COUNT = 5000
/** Documents the preview shows. */
export const PREVIEW = 5
/** What the Import wizard is handed at once: 1,000,000 characters of NDJSON (a download's text too). */
export const MAX_CHARS = 1_000_000
/**
 * The app's message limit (1 MiB of UTF-8, the whole message as JSON), less room for the message's
 * own fields: a text is measured as sent, every quote and backslash escaped once more (review I4).
 */
export const MESSAGE_BYTES = 1024 * 1024 - 4096

/** A text's size as the app receives it, in bytes; over `MESSAGE_BYTES` or `MAX_CHARS` it is refused. */
export const sentSize = (text: string): number => new TextEncoder().encode(JSON.stringify(text)).length
/** Whether the app takes this text in one message. */
export const fitsOneMessage = (text: string): boolean =>
  text.length <= MAX_CHARS && sentSize(text) <= MESSAGE_BYTES

export interface Settings {
  count: number
  /** Share of fields left out, 0–0.9. */
  blankShare: number
  lang: DataLanguage
  seed: number
  /** "Now" for dates: the time the tab opened (absent: a fixed day, for tests). */
  now?: number
}

type Doc = Record<string, unknown>
interface Part {
  key: string
  /** An array of objects at this key. */
  array: boolean
}
const partsOf = (path: string): Part[] =>
  path
    .split('.')
    .map((p) => (p.endsWith('[]') ? { key: p.slice(0, -2), array: true } : { key: p, array: false }))

/** Keys that would reach an object's prototype are never set. */
const SAFE = (key: string) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype'

export function generate(plans: readonly FieldPlan[], settings: Settings): Doc[] {
  const r = rand(settings.seed)
  const lists = LISTS[settings.lang] ?? EN
  const count = Math.max(0, Math.min(MAX_COUNT, Math.trunc(settings.count)))
  const blank = Math.max(0, Math.min(0.9, settings.blankShare))
  const used = plans.filter(
    (p) => p.include && templateOf(p.template) && partsOf(p.path).every((x) => SAFE(x.key)),
  )
  const docs: Doc[] = []
  for (let index = 0; index < count; index++) {
    const doc: Doc = {}
    // How many elements each array of objects has in this document, chosen once.
    const sizes = new Map<string, number>()
    // Which fields are left out; never all of them (wave 3 review: most documents were {}).
    const kept = used.map(() => !(blank > 0 && r.chance(blank)))
    if (used.length && !kept.includes(true)) kept[r.int(0, used.length - 1)] = true
    for (const [at, plan] of used.entries()) {
      if (!kept[at]) continue
      const template = templateOf(plan.template)!
      const make = () =>
        template.make({
          r,
          lists,
          index,
          ...(settings.now !== undefined ? { now: settings.now } : {}),
          ...(plan.existing ? { existing: plan.existing } : {}),
          ...(plan.constant !== undefined ? { constant: plan.constant } : {}),
        })
      const set = (target: Doc, parts: Part[], at: string): void => {
        const [part, ...rest] = parts
        if (!part) return
        if (!rest.length) {
          target[part.key] = make()
          return
        }
        const here = at ? `${at}.${part.key}` : part.key
        if (part.array) {
          let size = sizes.get(here)
          if (size === undefined) sizes.set(here, (size = r.int(1, 3)))
          const items = Array.isArray(target[part.key]) ? (target[part.key] as Doc[]) : []
          while (items.length < size) items.push({})
          target[part.key] = items
          for (const item of items) set(item, rest, `${here}[]`)
        } else {
          const child =
            target[part.key] && typeof target[part.key] === 'object' && !Array.isArray(target[part.key])
              ? (target[part.key] as Doc)
              : {}
          target[part.key] = child
          set(child, rest, here)
        }
      }
      set(doc, partsOf(plan.path), '')
    }
    docs.push(doc)
  }
  return docs
}

/** The documents the preview shows: the first of the set, made without making the rest. */
export const previewDocs = (plans: readonly FieldPlan[], settings: Settings): Doc[] =>
  generate(plans, { ...settings, count: Math.min(PREVIEW, settings.count) })

/** One document a line, as the Import wizard reads NDJSON. */
export const toNdjson = (docs: readonly Doc[]): string => docs.map((d) => JSON.stringify(d)).join('\n') + '\n'
