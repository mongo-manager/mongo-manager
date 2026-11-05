// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * UI redesign R2–R5 spec §6: the old look is gone and stays gone. No file imports the old kit (src/ui
 * is deleted), and no class names the old palette, a dark: colour variant (the tokens carry both
 * themes), raw white or black, or amber for a warning. Two exceptions, each for a reason:
 * - a connection's own colour is a fixed categorical palette chosen by its user (connections/colors.ts);
 * - a video or image preview letterboxes on black (gridfs/GridFsPreview.vue).
 */
const SRC = join(import.meta.dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|ts|css)$/.test(e.name) ? [join(dir, e.name)] : [],
  )

const LEGACY_CLASS =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|accent|caret|placeholder|decoration|shadow)-(?:gray|brand|error|success|warning|blue-light)-\d+\b/
// Also chained after another variant (md:dark:, hover:dark:) — review of R3–R5, minor 12.
const DARK_VARIANT = /(?<![\w-])(?:[a-z-]+:)*dark:[a-z]/
// Every utility that paints a colour, gradient stops included (review of R3–R5, I-1: a gradient that
// ended in white survived the dark theme).
const RAW_WHITE_BLACK =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|from|via|to|fill|stroke|ring|outline|divide|shadow|decoration|caret|accent)-(?:white|black)\b/
const AMBER = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring)-amber-\d+\b/
const EXEMPT: Record<string, RegExp[]> = {
  'connections/colors.ts': [AMBER],
  'gridfs/GridFsPreview.vue': [RAW_WHITE_BLACK],
}

describe('the old look is gone (UI redesign R2–R5 §6)', () => {
  it('has no old kit to import', () => {
    expect(existsSync(join(SRC, 'ui'))).toBe(false)
    const importers = files(SRC).filter((f) =>
      /from\s+['"](?:@\/|(?:\.\.?\/)+)ui\//.test(readFileSync(f, 'utf8')),
    )
    expect(importers.map((f) => relative(SRC, f))).toEqual([])
  })

  it('names no old palette, dark: variant, raw white or black, or amber', () => {
    const found: string[] = []
    for (const file of files(SRC)) {
      const name = relative(SRC, file).split(sep).join('/')
      // The token definitions themselves (`.dark { … }`, `--color-*`) are not classes.
      if (name === 'assets/main.css') continue
      const text = readFileSync(file, 'utf8')
      for (const rule of [LEGACY_CLASS, DARK_VARIANT, RAW_WHITE_BLACK, AMBER]) {
        if ((EXEMPT[name] ?? []).includes(rule)) continue
        const m = text.match(rule)
        if (m) found.push(`${name}: ${m[0]}`)
      }
    }
    expect(found).toEqual([])
  })

  // R4/R5: loading placeholders are the kit's DsSkeleton (a shimmer that stops for reduced motion),
  // not pulsing grey boxes made by hand. A pulsing dot or bar that says "live" is not a placeholder.
  it('draws no loading placeholder by hand', () => {
    const found = files(SRC)
      .filter((f) => !f.includes(`${sep}ds${sep}`))
      // Within one class string: a pulse and a grey fill together.
      .filter((f) =>
        /animate-pulse[^"'`\n]*bg-(?:muted|subtle|line)|bg-(?:muted|subtle|line)[^"'`\n]*animate-pulse/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative(SRC, f).split(sep).join('/'))
    expect(found).toEqual([])
  })

  // Review of R3–R5, minor 12: anything that pulses stops for reduced motion.
  it('pulses only where motion is welcome', () => {
    const found: string[] = []
    for (const file of files(SRC).filter((f) => f.endsWith('.vue'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/["'`]([^"'`]*\banimate-pulse\b[^"'`]*)["'`]/g)) {
        if (/(^|\s)motion-safe:animate-pulse\b/.test(m[1]!)) continue
        if (!m[1]!.includes('motion-reduce:animate-none')) found.push(`${relative(SRC, file)}: ${m[1]}`)
      }
    }
    expect(found).toEqual([])
  })

  // Review of R3–R5, minor 8: the palette's move left controls whose hover was their own colour (two
  // steps of the old palette became one token), so pointing at them showed nothing. A current table
  // row keeps its colour under the pointer on purpose.
  it('gives every hover a colour of its own', () => {
    const found: string[] = []
    for (const file of files(SRC).filter((f) => f.endsWith('.vue'))) {
      const name = relative(SRC, file).split(sep).join('/')
      // A bound value's quoted pieces are its class lists (each branch of a ternary on its own).
      const lists = [...readFileSync(file, 'utf8').matchAll(/"([^"]*)"/g)].flatMap((m) =>
        m[1]!.includes("'") ? [...m[1]!.matchAll(/'([^']*)'/g)].map((p) => p[1]!) : [m[1]!],
      )
      for (const list of lists) {
        const classes = list.split(/\s+/)
        const base = new Set(classes.filter((c) => !c.includes(':')))
        for (const c of classes)
          if (/^hover:(bg|text|border)-/.test(c) && base.has(c.slice(6))) found.push(`${name}: ${c}`)
      }
    }
    expect(found).toEqual(['ds/DsDataTable.vue: hover:bg-accent-soft'])
  })

  it('defines no old palette in the stylesheet', () => {
    const css = readFileSync(join(SRC, 'assets', 'main.css'), 'utf8')
    expect(css).not.toMatch(/--(?:ds|color)-brand-|--color-(?:gray|error|success|warning)-\d/)
  })
})
