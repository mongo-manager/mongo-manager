import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-10-26: Tailwind 4's `outline-none` and `outline-hidden` set `--tw-outline-style: none`, which a
 * later `focus-visible:outline-2` takes as its style: the keyboard's ring was never drawn (the data
 * model's boxes, a settings card's title). A ring hidden from the mouse names its style again for the
 * keyboard (`focus-visible:outline-solid`). Checked in each quoted class list (one split across
 * several strings is not seen: keep such a list in one).
 */
const SRC = join(import.meta.dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|ts)$/.test(e.name) ? [join(dir, e.name)] : [],
  )

describe('focus rings', () => {
  it('are drawn for the keyboard where the mouse’s outline is hidden', () => {
    const found: string[] = []
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8')
      // Each class list: a quoted string with a focus outline (any width, focus or focus-visible).
      for (const m of text.matchAll(
        /["'`]([^"'`]*focus(?:-visible)?:outline(?:-\d+)?(?=[\s"'`])[^"'`]*)["'`]/g,
      ))
        if (
          /(^|\s)outline-(none|hidden)(\s|$)/.test(m[1]!) &&
          !/(^|\s)focus(-visible)?:outline-(solid|dashed|dotted|double)(\s|$)/.test(m[1]!)
        )
          found.push(`${f.slice(SRC.length + 1)}: ${m[1]}`)
    }
    expect(found).toEqual([])
  })
})
