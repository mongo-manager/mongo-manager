// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import en from '../src/i18n/locales/en.json'
import tr from '../src/i18n/locales/tr.json'
import { FOLDER_REFUSALS, STAGES } from '@mongo-manager/shared/browser'

type Tree = { [key: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}
// Sets, not lists: plural forms ("1 item | {count} items") legitimately repeat a placeholder.
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()

describe('locales', () => {
  const E = flatten(en as Tree)
  const T = flatten(tr as Tree)

  it('have exactly the same keys', () => {
    expect([...T.keys()].sort()).toEqual([...E.keys()].sort())
  })

  // Review of the open's stop (fifth review, minor 1): what a live sync's plan, or a scheduled
  // start of one, says when its connection could not open is said in words, not as a code.
  it('name the reasons a live sync’s plan fails with', () => {
    // Sixth review (nit 3): the generic words of a per-person connection name no profiler level.
    // A scheduled start records the reason its plan threw (runner.ts): these can reach it.
    for (const code of [
      'oidc_per_person',
      'oidc_sign_in',
      'target_is_view',
      'drill_scratch',
      'personal_field',
      'plan',
      'copy',
    ])
      expect(E.has(`liveSync.refusal.${code}`), code).toBe(true)
    expect(E.get('connection.reasons.oidc_per_person')).not.toMatch(/level/i)
    // Eleventh review (minor 1): a personal field is refused in a comparison, an ignore list or a
    // pipeline as well as in a query: its words name no query.
    expect(E.get('masking.personalField')).not.toMatch(/query/i)
    expect(T.get('masking.personalField')).not.toMatch(/sorgu/i)
    // Twelfth review (nit 2): a refused write naming no field says it would change one.
    expect(E.get('masking.personalWriteUnnamed')).toMatch(/change/)
    expect(T.get('masking.personalWriteUnnamed')).toMatch(/değiştir/)
    expect(E.get('connection.reasons.oidc_level2')).toMatch(/level 1/)
  })

  it('use the same placeholders and no HTML', () => {
    for (const [key, value] of E) {
      expect(placeholders(T.get(key)!), key).toEqual(placeholders(value))
      expect(value, key).not.toMatch(/<[a-z]/i)
      expect(T.get(key), key).not.toMatch(/<[a-z]/i)
      expect(T.get(key)!.trim(), key).not.toBe('')
    }
  })

  // Short names reviews 6 (M-5) and 7 (M-8): vue-i18n's HTML check warns in development on every
  // message it matches, as "< > …" did. A copy of RE_HTML_TAG from @intlify/message-compiler 11.4
  // (core-base's detectHtmlTag uses it), which this package cannot import (not a dependency of its
  // own): if vue-i18n changes it, change this with it.
  // Short names review 8 (M-5): every folder refusal the server can send has its words, in both.
  it('word every folder refusal the server can send', () => {
    for (const why of FOLDER_REFUSALS) {
      expect(E.get(`destinations.pathWhy.${why}`), why).toBeTruthy()
      expect(T.get(`destinations.pathWhy.${why}`), `tr ${why}`).toBeTruthy()
    }
    expect(
      [...E.keys()]
        .filter((k) => k.startsWith('destinations.pathWhy.'))
        .map((k) => k.split('.')[2])
        .sort(),
    ).toEqual([...FOLDER_REFUSALS].sort())
  })

  it('trip no HTML warning in vue-i18n', () => {
    // Theirs is written #-\/: the range from # to /, spelled out here (# $ % & ' ( ) * + , - . /),
    // which takes the comma too.
    const html = /<\/?[\w\s="/.':;#$%&()*+,-]+>/
    expect(
      [...E, ...[...T].map(([k, v]) => [`tr:${k}`, v] as const)].filter(([, v]) => html.test(v)),
    ).toEqual([])
  })

  it('keep every message whole: no text spread into one key per character (phase 3d-3b)', () => {
    // A merge that spreads a string into an object leaves keys "0", "1", … of one character each.
    const spread = (tree: Tree, at: string): string[] =>
      Object.entries(tree).flatMap(([k, v]) => {
        if (typeof v === 'string') return []
        const chars = Object.entries(v).filter(([kk, vv]) => /^\d+$/.test(kk) && typeof vv === 'string')
        const here =
          chars.length > 1 && chars.every(([, vv]) => (vv as string).length === 1) ? [`${at}${k}`] : []
        return [...here, ...spread(v, `${at}${k}.`)]
      })
    expect([...spread(en as Tree, 'en:'), ...spread(tr as Tree, 'tr:')]).toEqual([])
  })

  it('use braces only for placeholders, so every message compiles (phase 1g-2)', () => {
    for (const [key, value] of [...E, ...[...T].map(([k, v]) => [`tr:${k}`, v] as const)]) {
      // vue-i18n reads every { … } as a placeholder: literal code belongs in a parameter.
      const stray = value.replace(/\{\w+\}/g, '').match(/[{}]/)
      expect(stray, `${key}: ${value}`).toBeNull()
    }
  })

  // Gap scan 2026-10-15: a few Turkish messages said "view" where every other one says "görünüm".
  it('call a MongoDB view "görünüm" in Turkish', () => {
    const english = [...T].filter(([, v]) => /\bview/i.test(v.replace(/\{\w+\}/g, '')))
    expect(english.map(([k, v]) => `${k}: ${v}`)).toEqual([])
  })
})

// Review 2026-10-13 (web): the stage picker showed message keys after the descriptions' key was
// reused for a plural. Every stage the builder offers says what it does, in both languages.
describe('stage descriptions', () => {
  it('names every stage of the builder in both languages', () => {
    for (const { operator } of STAGES) {
      const key = operator.slice(1)
      expect((en.aggregation.stageHelp as Record<string, string>)[key], `en ${operator}`).toBeTruthy()
      expect((tr.aggregation.stageHelp as Record<string, string>)[key], `tr ${operator}`).toBeTruthy()
    }
  })
})
