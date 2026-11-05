// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '../../kit/src/ui'

const manifest = JSON.parse(
  readFileSync(new URL('../public/mongo-manager-plugin.json', import.meta.url), 'utf8'),
)

/** Every `{ en: ... }` object in the manifest. */
function localized(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.en === 'string') found.push(o)
    else for (const v of Object.values(o)) localized(v, found)
  }
  return found
}

describe('the manifest’s words', () => {
  it('has every localized text in all ten languages, within the limits', () => {
    const check = (o: unknown, limit: number, what: string) => {
      const texts = o as Record<string, string>
      expect(Object.keys(texts).sort(), what).toEqual([...LANGUAGES].sort())
      for (const lang of LANGUAGES) {
        expect(texts[lang]!.length, `${what} ${lang}`).toBeGreaterThan(0)
        expect(texts[lang]!.length, `${what} ${lang}`).toBeLessThanOrEqual(limit)
      }
    }
    expect(localized(manifest).length).toBeGreaterThan(10)
    check(manifest.name, 60, 'name')
    check(manifest.description, 300, 'description')
    for (const kind of Object.values(manifest.contributes) as { title?: unknown }[][])
      for (const item of kind) if (item.title) check(item.title, 40, 'contribution title')
    for (const [key, setting] of Object.entries(manifest.settings) as [string, { title: unknown }][])
      check(setting.title, 60, `setting ${key}`)
    for (const entry of manifest.changelog) check(entry.notes, 1000, `notes ${entry.version}`)
    const strict = new Set<unknown>([
      manifest.name,
      manifest.description,
      ...manifest.changelog.map((e: { notes: unknown }) => e.notes),
    ])
    for (const o of localized(manifest)) if (!strict.has(o)) check(o, 60, 'other text')
  })

  it('is released as the newest changelog entry', () => {
    expect(manifest.changelog[0].version).toBe(manifest.version)
    expect(manifest.changelog[0].date).toBe(manifest.publishedAt)
  })
})
