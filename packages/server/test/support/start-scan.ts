import { readdirSync, readFileSync } from 'node:fs'
import { SERVER_START_MS, SET_START_MS, SLOW_RUNNER } from './slowness'

/**
 * Reads the tests and hooks of a test file: the time each is given, and the time the MongoDB servers
 * it starts itself need (start-budget.test.ts; review of the Windows hardening, rounds two to four).
 * A helper that starts one for it is not seen, but startTlsMongo.
 */

/** vitest's times for a test and a hook that name none (vitest.config.ts, before any scaling). */
export const DEFAULTS: Record<string, number> = {
  it: 20_000,
  test: 20_000,
  beforeAll: 120_000,
  beforeEach: 120_000,
  afterAll: 120_000,
  afterEach: 120_000,
}
/**
 * A test or a hook: `it(`, `it.each<…>(…)(`, `beforeAll(`, `afterAll(`…; not a call with nothing
 * in it, `test.skip()` in a body (fifth review, nit 9).
 */
const OPENER = /^( *)(it|test|beforeAll|beforeEach|afterAll|afterEach)(\.\w+)?(<[^(]*>)?\((?!\))/
const START = /\b(MongoMemoryServer\.create|MongoMemoryReplSet\.create|startMongo|startTlsMongo)\(/g
const GROUP = /\b(Promise\.all|Promise\.allSettled|together)\(/g
/** A loop: for, for await, while, do, forEach (fifth review, nit 3). */
const LOOP = /\bfor\s*(?:await\s*)?\(|\bwhile\s*\(|\bdo\s*\{|\.forEach\(/g
/** A test's time after its function, on its one line: a number, a name, or slow(…) or asIs(…) of one. */
const ONE_LINE_TIME = /\}, ((?:slow|asIs)\(\w+\)|\w+)\)$/

export interface Found {
  line: number
  kind: string
  /** The time it is given, as a fast runner gives it; NaN where it could not be read. */
  ms: number
  /** The time it names, as written; undefined where it names none. */
  named: string | undefined
  /** The line its time is named on. */
  at: number | undefined
  /** The time the servers it starts need; NaN where it cannot tell (a start in a loop). */
  need: number
}

const budget = (call: string) => (call === 'MongoMemoryReplSet.create' ? SET_START_MS : SERVER_START_MS)

/** Where the bracket opened at `open` closes (the end of `text` if it does not). */
function closing(text: string, open: number): number {
  let depth = 0
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++
    else if (text[k] === ')' && --depth === 0) return k
  }
  return text.length
}

/**
 * The servers a body starts, and the time they need: each one started on its own adds its budget;
 * those started together (inside the brackets of a Promise.all or a together()) take the longest of
 * theirs, each group once (fifth review, nit 1); a start after a loop may run any number of times
 * (NaN). Comments are not read.
 */
export function needOf(source: string): number {
  const body = source.replace(/\/\/.*$/gm, '')
  const starts = [...body.matchAll(START)]
  if (starts.length === 0) return 0
  const loop = [...body.matchAll(LOOP)].map((m) => m.index)
  if (loop.some((l) => starts.some((s) => s.index > l))) return Number.NaN
  const groups = [...body.matchAll(GROUP)].map((m) => {
    const open = m.index + m[0].length - 1
    return { open, close: closing(body, open) }
  })
  let alone = 0
  const together = new Map<number, number>()
  for (const s of starts) {
    const call = budget(s[1]!)
    // The innermost group whose brackets hold it.
    const group = groups.filter((g) => g.open < s.index && s.index < g.close).at(-1)
    if (group === undefined) alone += call
    else together.set(group.open, Math.max(together.get(group.open) ?? 0, call))
  }
  return alone + [...together.values()].reduce((a, b) => a + b, 0)
}

/** A named time: a number, a budget by its name, slow(that) as a fast runner gives it, asIs(that). */
export function timeOf(named: string): number {
  const budgets: Record<string, number> = { SERVER_START_MS, SET_START_MS }
  const inner = /^(?:slow|asIs)\((.+)\)$/.exec(named)?.[1] ?? named
  if (/^[0-9_]+$/.test(inner)) return Number(inner.replaceAll('_', ''))
  return budgets[inner] ?? Number.NaN
}

/** Every test and hook in `source`, with the time it is given and the time its servers need. */
export function tests(source: string): Found[] {
  const lines = source.split('\n')
  const bare = (l: string) => l.replace(/\s*\/\/.*$/, '')
  const found: Found[] = []
  lines.forEach((text, i) => {
    const open = OPENER.exec(text)
    if (!open) return
    const indent = open[1]!
    const kind = open[2]!
    // A test on one line ends there, its time too; one whose arguments are on lines of their own,
    // at its ")". A closing line's comment is not its time.
    const oneLine = /\}(?:, .+)?\)$/.test(bare(text).trimEnd())
    const end = oneLine
      ? i
      : lines.findIndex(
          (l, j) =>
            j > i &&
            (bare(l).startsWith(`${indent}})`) ||
              bare(l).startsWith(`${indent}}, `) ||
              bare(l) === `${indent})`),
        )
    if (end < 0) {
      found.push({
        line: i + 1,
        kind,
        ms: Number.NaN,
        named: undefined,
        at: undefined,
        need: needOf(lines.slice(i).join('\n')),
      })
      return
    }
    const close = bare(lines[end]!).trimEnd()
    const body = lines.slice(i, end + 1).join('\n')
    // Its time: after the function, on the closing line or on a line before a ")" of its own; or
    // in its options, before its function (on the opener's line, or on one of their own).
    let named: string | undefined
    let at: number | undefined
    // On one line, only a time-shaped last argument is its time (fifth review, nit 2).
    const after = (oneLine ? ONE_LINE_TIME : new RegExp(`^${indent}\\}, (.+)\\)$`)).exec(close)?.[1]
    if (after !== undefined) [named, at] = [after, end + 1]
    else if (close === `${indent})`) {
      const last = /^\s*([^}\s][^,]*),$/.exec(bare(lines[end - 1]!))?.[1]
      if (last !== undefined) [named, at] = [last, end]
    }
    if (named === undefined) {
      // Up to where its function's body begins, not into it (fifth review, nit 4).
      const head = lines.findIndex((l, j) => j >= i && /\{$/.test(bare(l).trimEnd()))
      for (let j = i; j <= (head < 0 ? i : head); j++) {
        const option = /timeout: ([^,}\s]+)/.exec(bare(lines[j]!))?.[1]
        if (option !== undefined) {
          ;[named, at] = [option, j + 1]
          break
        }
      }
    }
    const ms = named === undefined ? DEFAULTS[kind]! : timeOf(named)
    found.push({ line: i + 1, kind, ms, named, at, need: needOf(body) })
  })
  return found
}

/** Whether a test or a hook gives the servers it starts their time; NaN on either side is not enough. */
export const enough = (s: Found): boolean => s.need === 0 || s.ms >= s.need

/**
 * Whether a named time is right on a slow runner (review of the Windows hardening, third round, A;
 * fourth, Minors 1, 2): one shorter than a slow runner's default is named with slow(), or asIs()
 * when it is a limit of its own; one that cannot be read is not.
 */
export function scaled(s: Found): boolean {
  if (s.named === undefined) return true
  if (Number.isNaN(timeOf(s.named))) return false
  if (/^(?:slow|asIs)\(/.test(s.named)) return true
  return timeOf(s.named) >= DEFAULTS[s.kind]! * SLOW_RUNNER
}

/** Every test file, in sub-folders too, but the scan's own test, whose examples are not tests. */
export function testFiles(): Array<{ name: string; source: string }> {
  const dir = new URL('../', import.meta.url)
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => f.endsWith('.test.ts') && f !== 'start-budget.test.ts')
    .map((f) => ({ name: f, source: readFileSync(new URL(f, dir), 'utf8') }))
}
