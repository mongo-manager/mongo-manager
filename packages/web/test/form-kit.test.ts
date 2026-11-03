import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI redesign R1 (user, 2026-10-07: "modal içerisindeki form tasarımları hoşuma gitmedi"): the modal
 * and form kit every older screen uses is drawn in the new design language — tokens only, no old
 * palette — so every dialog's form looks like the rest of the app.
 */
const src = join(import.meta.dirname, '../src')
// UI redesign part K: the old kit moved into ds/, so every kit component is held to it.
const FILES = [
  ...readdirSync(join(src, 'ds'))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => `ds/${f}`),
  'connections/ConnectionDialog.vue',
]
// The old palette: grays, white/black and brand by any step; success, warning and error only by their
// numbered steps (the new tokens are text-success, bg-warning-soft…).
const LEGACY =
  /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|accent|caret|placeholder)-(?:(?:gray|white|black|brand|slate|zinc)(?:-\d+)?|(?:success|error|warning)-\d+)\b|dark:/

describe('the modal and form kit speaks the new design language', () => {
  for (const file of FILES)
    it(file, () => {
      const source = readFileSync(join(src, file), 'utf8')
      const template = source.slice(source.indexOf('<template>'))
      expect(template.match(LEGACY)?.[0] ?? null).toBeNull()
    })

  it('the pattern catches the old palette and lets the tokens pass', () => {
    for (const old of ['bg-gray-100', 'text-brand-600', 'border-error-500', 'text-white', 'dark:bg-x'])
      expect(old, old).toMatch(LEGACY)
    for (const token of ['bg-warning-soft', 'text-success', 'border-danger/25', 'bg-accent', 'text-fg-muted'])
      expect(token, token).not.toMatch(LEGACY)
  })
})
