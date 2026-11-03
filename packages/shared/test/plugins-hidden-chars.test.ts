import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isHiddenAt } from '../src/chars'

/**
 * Review of the last four languages (minor 1): the plugins keep their words in code, so the lint's
 * odd-space rule skips their strings (French puts U+202F before ; : ! ?). No lint rule ever checked
 * them for characters that reverse or hide text, so this test reads every plugin's source and its
 * README files: nothing that hides, reverses or blanks text (the app's own list), and no odd space but
 * the no-break ones French typography uses.
 */
const ROOT = join(__dirname, '..', '..', 'plugins')
const ALLOWED = new Set([0x09, 0x0a, 0x0d])
const ODD_SPACES = new Set([
  0x85,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x205f,
  0x3000,
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|js|vue|json|md|html|css)$/.test(name) ? [path] : []
  })
}

/** What a text holds that it may not: each as its line and code point. */
function findings(text: string): string[] {
  const chars = [...text]
  const found: string[] = []
  let line = 1
  chars.forEach((c, i) => {
    const code = c.codePointAt(0)!
    if (code === 0x0a) line += 1
    if (ALLOWED.has(code)) return
    if (isHiddenAt(chars, i) || ODD_SPACES.has(code))
      found.push(`line ${line}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`)
  })
  return found
}

const plugins = readdirSync(ROOT).filter((name) => existsSync(join(ROOT, name, 'package.json')))

describe('the plugins’ characters', () => {
  it('finds a hidden or odd character', () => {
    expect(findings('a' + String.fromCodePoint(0x202e) + 'b')).toEqual(['line 1: U+202E'])
    expect(findings('x' + String.fromCodePoint(0x200b))).toEqual(['line 1: U+200B'])
    expect(findings('1' + String.fromCodePoint(0x3000) + '2')).toEqual(['line 1: U+3000'])
    expect(findings('a' + String.fromCodePoint(0x85))).toEqual(['line 1: U+0085'])
  })

  it('lets through what text uses: tabs, line ends, French no-break spaces, an emoji’s joiner', () => {
    const nnbsp = String.fromCodePoint(0x202f)
    const emoji = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)
    expect(findings(`a\tb\r\nc${nnbsp}:${String.fromCodePoint(0xa0)}d ${emoji}`)).toEqual([])
  })

  it('reads every plugin', () => {
    expect(plugins.length).toBeGreaterThanOrEqual(27)
  })

  for (const plugin of plugins)
    it(`${plugin} holds nothing that hides or reverses text`, () => {
      const dir = join(ROOT, plugin)
      const bad = files(dir).flatMap((path) =>
        findings(readFileSync(path, 'utf8')).map((f) => `${relative(ROOT, path)} ${f}`),
      )
      expect(bad).toEqual([])
    })
})
