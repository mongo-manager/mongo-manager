import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * UI review at a phone's width (2026-10-23): Performance scrolled sideways. A chart's table for screen
 * readers carried `sr-only` itself; a table is never narrower than its content and does not clip what
 * overflows it, so the hidden table kept its width and pushed the page. It sits in an `sr-only` box.
 */
describe('tables for screen readers only', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  const vueFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? vueFiles(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
    )

  it('are hidden by a box around them, not by sr-only on the table', () => {
    const offenders = vueFiles(SRC)
      .filter((f) => /<table\b[^>]*\bsr-only\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
    expect(offenders).toEqual([])
  })
})
