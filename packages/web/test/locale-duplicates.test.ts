import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Review of B5 (minor 4): a key written twice in one object of a locale file is read as its last
 * line only — the first is dead text no one sees. JSON.parse keeps quiet about it; this scan does not.
 */
function duplicates(text: string): string[] {
  const out: string[] = []
  const stack: Array<{ keys: Set<string>; path: string; object: boolean }> = []
  let i = 0
  let pendingKey: string | null = null
  const readString = (): string => {
    let s = ''
    i++
    while (text[i] !== '"') {
      if (text[i] === '\\') {
        s += text[i]! + text[i + 1]!
        i += 2
      } else s += text[i++]
    }
    i++
    return s
  }
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '{' || ch === '[') {
      const top = stack.at(-1)
      stack.push({
        keys: new Set(),
        path: `${top?.path ?? ''}${pendingKey ? `.${pendingKey}` : ''}`,
        object: ch === '{',
      })
      pendingKey = null
      i++
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      i++
    } else if (ch === '"') {
      const s = readString()
      const top = stack.at(-1)
      let j = i
      while (/\s/.test(text[j]!)) j++
      if (top?.object && text[j] === ':') {
        if (top.keys.has(s)) out.push(`${top.path}.${s}`)
        top.keys.add(s)
        pendingKey = s
        i = j + 1
      }
    } else {
      if (ch === ',') pendingKey = null
      i++
    }
  }
  return out
}

describe('the locale files', () => {
  for (const lang of ['en', 'tr'])
    it(`write no key twice (${lang})`, () => {
      const path = join(import.meta.dirname, '..', 'src', 'i18n', 'locales', `${lang}.json`)
      expect(duplicates(readFileSync(path, 'utf-8'))).toEqual([])
    })

  it('finds a key written twice', () => {
    expect(duplicates('{"a": {"b": "1", "b": "2"}, "c": ["x", {"d": 1}]}')).toEqual(['.a.b'])
  })
})
