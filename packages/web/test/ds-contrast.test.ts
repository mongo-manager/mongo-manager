import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** UI redesign R1 spec §1.2: every text and icon token reaches WCAG AA where it is used, in both themes. */
const css = readFileSync(join(import.meta.dirname, '../src/assets/main.css'), 'utf8')
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--ds-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  )
}
const LIGHT = block(':root')
const DARK = { ...LIGHT, ...block('.dark') }
type Rgba = [number, number, number, number]
function parse(color: string): Rgba {
  if (color.startsWith('#')) {
    const h = color.slice(1)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const parts = /rgba?\(([^)]+)\)/
    .exec(color)![1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]
}
const over = (top: Rgba, base: Rgba): Rgba => {
  const a = top[3]
  return [top[0] * a + base[0] * (1 - a), top[1] * a + base[1] * (1 - a), top[2] * a + base[2] * (1 - a), 1]
}
const luminance = ([r, g, b]: Rgba) => {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(theme: Record<string, string>, fg: string, bg: string): number {
  const back = over(parse(theme[bg]!), parse(theme.surface!))
  const front = over(parse(theme[fg]!), back)
  const [a, b] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

const TEXT: Array<[string, string[]]> = [
  ['fg', ['surface', 'canvas', 'subtle', 'raised', 'muted']],
  ['fg-muted', ['surface', 'canvas', 'subtle', 'raised']],
  ['fg-subtle', ['surface', 'canvas', 'raised', 'subtle', 'muted']],
  ['accent-fg', ['surface', 'accent-soft']],
  ['on-accent', ['accent']],
  ['on-danger', ['danger']],
  ['danger', ['surface', 'danger-soft']],
  ['warning', ['surface', 'warning-soft']],
  ['info', ['surface', 'info-soft']],
  ['success', ['surface', 'success-soft']],
  ['on-tooltip', ['tooltip']],
  ['v-string', ['surface', 'subtle']],
  ['v-number', ['surface', 'subtle']],
  ['v-boolean', ['surface', 'subtle']],
  ['v-null', ['surface']],
  ['v-date', ['surface', 'subtle']],
  ['v-oid', ['surface', 'subtle']],
  ['v-key', ['surface', 'subtle']],
]

describe('design tokens (UI redesign R1 spec §1.2)', () => {
  for (const [name, theme] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)
    describe(`the ${name} theme`, () => {
      for (const [fg, backs] of TEXT)
        for (const bg of backs)
          it(`${fg} on ${bg} reaches 4.5:1`, () => expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5))
      it('the focus ring is seen on the surface (3:1)', () =>
        expect(ratio(theme, 'focus', 'surface')).toBeGreaterThanOrEqual(3))
    })

  // Revision 2 (spec §1.2): five accents, each readable in both themes.
  for (const accent of ['emerald', 'indigo', 'violet', 'ocean', 'rose'])
    for (const [name, base, selector] of [
      ['light', LIGHT, `[data-accent='${accent}']`],
      ['dark', DARK, `.dark [data-accent='${accent}']`],
    ] as const)
      describe(`the ${accent} accent, ${name}`, () => {
        const theme = { ...base, ...block(selector) }
        for (const [fg, bg] of [
          ['on-accent', 'accent'],
          ['accent-fg', 'surface'],
          ['accent-fg', 'canvas'],
          ['accent-fg', 'accent-soft'],
        ] as const)
          it(`${fg} on ${bg} reaches 4.5:1`, () => expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5))
        it('its focus ring is seen on the surface (3:1)', () =>
          expect(ratio(theme, 'focus', 'surface')).toBeGreaterThanOrEqual(3))
        it('sets every accent token', () =>
          expect(Object.keys(block(selector)).sort()).toEqual([
            'accent',
            'accent-fg',
            'accent-hover',
            'accent-soft',
            'focus',
            'on-accent',
          ]))
      })

  it('every token has a dark value', () => {
    const dark = block('.dark')
    const missing = Object.keys(LIGHT).filter((k) => !(k in dark))
    expect(missing).toEqual([])
  })
})

// UI redesign R1 review: selected text was white on #e7f5ee (the selection gave a background and no
// colour, so the browser painted the text white). The selection names both, in every accent and theme.
describe('selected text', () => {
  it('sets its own text colour and background', () => {
    const rule = /::selection\s*\{([^}]*)\}/.exec(css)![1]!
    expect(rule).toMatch(/background(-color)?:\s*var\(--ds-selection\)/)
    expect(rule).toMatch(/(^|[\s;])color:\s*var\(--ds-fg\)/)
  })

  for (const accent of ['emerald', 'indigo', 'violet', 'ocean', 'rose'])
    for (const [name, base, selector] of [
      ['light', LIGHT, `[data-accent='${accent}']`],
      ['dark', DARK, `.dark [data-accent='${accent}']`],
    ] as const)
      it(`is readable and seen in ${accent}, ${name}`, () => {
        const theme = { ...base, ...block(selector) }
        const mix = /color-mix\(in srgb, var\(--ds-accent\) (\d+)%, transparent\)/.exec(theme.selection!)
        expect(mix, theme.selection).not.toBeNull()
        const [r, g, b] = parse(theme.accent!)
        const surface = parse(theme.surface!)
        const back = over([r, g, b, Number(mix![1]) / 100], surface)
        const text = parse(theme.fg!)
        const [hi, lo] = [luminance(text), luminance(back)].sort((x, y) => y - x) as [number, number]
        expect((hi + 0.05) / (lo + 0.05), 'text on the selection').toBeGreaterThanOrEqual(4.5)
        // The selection itself stands out from the page (not the faint soft accent).
        const [s1, s2] = [luminance(back), luminance(surface)].sort((x, y) => y - x) as [number, number]
        expect((s1 + 0.05) / (s2 + 0.05), 'selection against the surface').toBeGreaterThanOrEqual(1.25)
      })
})
