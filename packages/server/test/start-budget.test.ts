import { describe, expect, it } from 'vitest'
import { SERVER_START_MS, SET_START_MS } from './support/slowness'
import { enough, scaled, testFiles, tests, timeOf, type Found } from './support/start-scan'

const S = SERVER_START_MS

/**
 * Review of the Windows hardening (second round, Minor 1; third, A, B; fourth, Minors 1, 2): a test or
 * a hook that starts a server itself gives it the time two slow starts take (a set's members, and its
 * primary, too), a server it awaits after another the sum of theirs, so a slow runner's failure is
 * said as the server's, not as the test's time running out; and a time a test or a hook names that
 * is shorter than a slow runner's default is named with slow(), or asIs() when it is a limit of its
 * own (support/start-scan.ts).
 */
describe('the time a test or a hook gives the servers it starts', () => {
  const source = [
    "it('a', async () => {",
    '  await startMongo()',
    '})',
    'beforeAll(async () => {',
    '  await MongoMemoryReplSet.create()',
    '}, slow(180_000))',
    "it('b', { timeout: slow(95_000) }, async () => {",
    '  await MongoMemoryServer.create()',
    '})',
    "it('c', () => {})",
    '  beforeAll(async () => {',
    '    await startMongo()',
    '  }, slow(SERVER_START_MS)) // why',
    "it('d', async () => {",
    '  await startMongo()',
    '}, slow(15_000))',
    "it('e', async () => {",
    '  await startMongo()',
    '}, SOMETHING_ELSE)',
    'it(',
    "  'f, its arguments on lines of their own',",
    '  async () => {',
    '    await MongoMemoryReplSet.create()',
    '  },',
    '  slow(SET_START_MS),',
    ')',
    "it.each<[string]>([['x']])('g %s', async () => {",
    '  const a = await startMongo()',
    '  const b = await MongoMemoryReplSet.create()',
    '  await Promise.all([startMongo(), MongoMemoryReplSet.create()])',
    '  await together([startMongo()])',
    '}, slow(600_000))',
    "it('i', async () => { await startTlsMongo() }, slow(95_000))",
    'it(',
    "  'j',",
    '  { timeout: 30_000 },',
    '  async () => {',
    '    for (const n of [1, 2]) await startMongo()',
    '  },',
    ')',
    "it('k', async () => {",
    '  await restartMongo()',
    '}, 10 * 1000)',
    "it('h', async () => {",
    '  await startMongo()',
  ].join('\n')

  it('reads what a test or a hook starts, and its time', () => {
    const found = (line: number, kind: string, ms: number, named?: string, at?: number, need = 0): Found => ({
      line,
      kind,
      ms,
      named,
      at,
      need,
    })
    expect(tests(source)).toEqual([
      found(1, 'it', 20_000, undefined, undefined, S),
      found(4, 'beforeAll', 180_000, 'slow(180_000)', 6, SET_START_MS),
      found(7, 'it', 95_000, 'slow(95_000)', 7, S),
      found(10, 'it', 20_000),
      // A closing line's comment is not its time.
      found(11, 'beforeAll', S, 'slow(SERVER_START_MS)', 13, S),
      found(14, 'it', 15_000, 'slow(15_000)', 16, S),
      found(17, 'it', Number.NaN, 'SOMETHING_ELSE', 19, S),
      found(20, 'it', SET_START_MS, 'slow(SET_START_MS)', 25, SET_START_MS),
      // One after another, then two groups together: the sum, and each group's longest once.
      found(27, 'it', 600_000, 'slow(600_000)', 32, S + SET_START_MS + SET_START_MS + S),
      // A test on one line, its time on it; startTlsMongo is a start.
      found(33, 'it', 95_000, 'slow(95_000)', 33, S),
      // Its options on a line of their own; a start in a loop (NaN).
      found(34, 'it', 30_000, '30_000', 36, Number.NaN),
      // restartMongo is not a start; an expression is not read.
      found(41, 'it', Number.NaN, '10 * 1000', 43),
      // Its end not found.
      found(44, 'it', Number.NaN, undefined, undefined, S),
    ])
  })

  it('finds a test that gives its servers too little time, or cannot be read', () => {
    expect(
      tests(source)
        .filter((s) => !enough(s))
        .map((s) => s.line),
    ).toEqual([1, 14, 17, 34, 44])
  })

  it('finds a time shorter than a slow runner’s default that is not named with slow() or asIs()', () => {
    expect(
      tests(source)
        .filter((s) => !scaled(s))
        .map((s) => s.line),
    ).toEqual([17, 34, 41])
    const named = (kind: string, n: string) =>
      scaled({ line: 1, kind, ms: timeOf(n), named: n, at: 1, need: 0 })
    // A hook's default is longer: 120 s, bare, is shorter than a slow runner's (fourth round, Minor 1).
    expect(
      ['120_000', '400_000', 'slow(120_000)', 'SET_START_MS', 'slow(SET_START_MS)'].map((n) =>
        named('beforeAll', n),
      ),
    ).toEqual([false, true, true, false, true])
    // slow() of something it cannot read is not taken for scaled.
    expect(
      ['30_000', '60_000', 'asIs(20_000)', 'SERVER_START_MS', 'slow(SOMETHING)'].map((n) => named('it', n)),
    ).toEqual([false, true, true, true, false])
    // The exact forms only (fourth round, nit 4).
    expect(['20_000)', 'slow(20_000', 'slow(SET_START_MS)'].map(timeOf)).toEqual([
      Number.NaN,
      Number.NaN,
      SET_START_MS,
    ])
  })

  // Fifth review of the Windows hardening (nits 1-4, 9): groups end at their ")", a one-line test's
  // options are its time, a loop is a loop, the options end where the function's body begins, and
  // after-hooks and a test.skip() call are read as they are.
  it('reads groups, options, loops and after-hooks as they are', () => {
    const more = [
      "it('l', async () => {",
      '  const [a, b] = await Promise.all([startMongo(), startMongo()])',
      '  const c = startMongo()',
      '  await c',
      '}, slow(400_000))',
      "it('m', { timeout: slow(95_000) }, async () => { await startMongo() })",
      "it('n', async () => {",
      '  // waits for (at most) a minute',
      '  await startMongo()',
      '}, slow(95_000))',
      "it('o', async () => {",
      '  for await (const x of xs) await startMongo()',
      '}, slow(95_000))',
      "it('p', async function () {",
      '  await startMongo()',
      '  await until(() => ready, { timeout: 95_000 })',
      '})',
      'afterAll(async () => {',
      '  await done()',
      '}, 30_000)',
      "it('q', async () => {",
      '  test.skip()',
      '  await startMongo()',
      '}, slow(95_000))',
      "it('r', async () => {",
      '  do {',
      '    await startMongo()',
      '  } while (again)',
      '}, slow(95_000))',
    ].join('\n')
    const found = tests(more)
    expect(found.map((s) => [s.line, s.kind, s.ms, s.named, s.at, s.need])).toEqual([
      // One group, then a start of its own: they add up.
      [1, 'it', 400_000, 'slow(400_000)', 5, 2 * S],
      // Its options on its one line are its time.
      [6, 'it', 95_000, 'slow(95_000)', 6, S],
      // "for (" in a comment is no loop.
      [7, 'it', 95_000, 'slow(95_000)', 10, S],
      // for await is a loop.
      [11, 'it', 95_000, 'slow(95_000)', 13, Number.NaN],
      // A wait's timeout in the body is not the test's.
      [14, 'it', 20_000, undefined, undefined, S],
      [18, 'afterAll', 30_000, '30_000', 20, 0],
      // test.skip() in a body opens nothing.
      [21, 'it', 95_000, 'slow(95_000)', 24, S],
      // do … while is a loop.
      [25, 'it', 95_000, 'slow(95_000)', 29, Number.NaN],
    ])
    expect(found.filter((s) => !enough(s)).map((s) => s.line)).toEqual([11, 14, 25])
    expect(found.filter((s) => !scaled(s)).map((s) => s.line)).toEqual([18])
  })

  it('holds in every test file', () => {
    const files = testFiles()
    // Sub-folders too.
    expect(files.map((f) => f.name)).toContain('fixtures/backup/make-fixtures.test.ts')
    const wrong = files.flatMap(({ name, source }) =>
      tests(source).flatMap((s) => [
        ...(enough(s) ? [] : [`${name}:${s.line} gives ${s.ms} ms, its servers need ${s.need} ms`]),
        ...(scaled(s) ? [] : [`${name}:${s.at} names ${s.named} unscaled`]),
      ]),
    )
    expect(wrong).toEqual([])
  })
})
