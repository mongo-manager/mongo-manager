import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI redesign R1 (user, 2026-10-07: "temaya bağlı kal, iç sayfalardaki renkler karışıyor"): screens
 * not yet rewritten follow the theme too. Their old palette names are bound to the theme's tokens, so
 * the accent, light and dark reach every page, and the old TailAdmin blue appears nowhere.
 */
const src = join(import.meta.dirname, '../src')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|ts|css)$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

describe('the old palette follows the theme', () => {
  // The brand steps' mapping went with the old palette itself (UI redesign R2–R5 §6): legacy-gone.test.ts
  // keeps its names out of the app.
  it('has no TailAdmin blue or navy gray left anywhere in the app', () => {
    const offenders = files(src).filter((f) =>
      /#465fff|#101828|#1d2939|#1a2231/i.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('has no dark gray text on hover without a dark-mode value (reviewer C Minor 10)', () => {
    const offenders = files(src).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .filter((l) => /hover:text-gray-[6-9]00/.test(l) && !/dark:hover:text-/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})
