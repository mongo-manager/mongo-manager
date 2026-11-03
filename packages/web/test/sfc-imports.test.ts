import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * UI redesign R2: a component used in a template but never imported renders as an unknown element —
 * no error at build, type check or test time (the Overview lost its cards that way). Every
 * PascalCase tag in a template is imported (or registered) in its file, or is one of Vue's own.
 */
const SRC = join(import.meta.dirname, '..', 'src')
const BUILT_IN = new Set([
  'Teleport',
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'RouterView',
  'RouterLink',
  'Component',
])

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
  )

/** The names a file's scripts bring in: default and named imports, and defineAsyncComponent constants. */
function declared(source: string): Set<string> {
  const names = new Set<string>()
  // A type-only import is no component: `import type X` brings nothing a template can render.
  for (const m of source.matchAll(/import\s+([A-Z]\w*)(?:\s*,\s*\{([^}]*)\})?\s+from/g)) {
    names.add(m[1]!)
    for (const n of (m[2] ?? '').split(','))
      names.add(
        n
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()!,
      )
  }
  for (const m of source.matchAll(/import\s+\{([^}]*)\}\s+from/g))
    for (const n of m[1]!.split(','))
      names.add(
        n
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()!,
      )
  for (const m of source.matchAll(/const\s+([A-Z]\w*)\s*=/g)) names.add(m[1]!)
  return names
}

describe('every component a template uses is imported', () => {
  for (const file of files(SRC)) {
    const name = relative(SRC, file).split(sep).join('/')
    it(name, () => {
      const source = readFileSync(file, 'utf8')
      const start = source.indexOf('<template>')
      if (start < 0) return
      const template = source.slice(start)
      // Components are written in PascalCase, so the check below sees every one of them.
      expect([...template.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)[\s/>]/g)].map((m) => m[1])).toEqual([])
      const used = new Set([...template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))
      const own = file
        .split(sep)
        .pop()!
        .replace(/\.vue$/, '')
      const known = declared(source.slice(0, start) + source.slice(source.lastIndexOf('<script')))
      const missing = [...used].filter((n) => !known.has(n) && !BUILT_IN.has(n) && n !== own)
      expect(missing).toEqual([])
    })
  }
})
