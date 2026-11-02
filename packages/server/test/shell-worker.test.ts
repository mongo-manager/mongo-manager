import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { startMongo, type TestMongo } from './support/mongo'
import { startTestWorker, type TestWorker } from './support/shell-worker'
import type { WorkerToShell } from '../src/shell/ipc'
import { workerArgs, workerEnv } from '../src/shell/spawn'
import { slow } from './support/slowness'

let mongo: TestMongo
let uri: string
beforeAll(async () => {
  mongo = await startMongo()
  uri = `mongodb://${mongo.host}:${mongo.port}/?directConnection=true`
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})

const workers: TestWorker[] = []
afterEach(() => {
  for (const w of workers.splice(0)) w.close()
})

/** Canonical EJSON wraps numbers ({$numberInt:'2'}); pull the number back out for assertions. */
function num(value: unknown): number {
  if (typeof value === 'number') return value
  const wrapped = value as Record<string, string>
  const key = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'].find(
    (k) => k in (wrapped ?? {}),
  )
  return key ? Number(wrapped[key]) : NaN
}

async function connected(db = 'shop', syncTimeoutMs = 5_000): Promise<TestWorker> {
  const { worker } = await startTestWorker({ uri, db, syncTimeoutMs })
  workers.push(worker)
  await worker.next('ready')
  return worker
}

describe('shell worker: mongosh in the sandbox (phase 3a-1 §3)', () => {
  it('answers ready and runs queries, loops and show dbs', async () => {
    const worker = await connected('shop')
    expect(await worker.evaluate('use shop')).toMatchObject({ ok: true })
    const insert = await worker.evaluate('db.items.insertMany([{a:1},{a:2},{a:3}])')
    expect(insert.ok).toBe(true)
    const found = await worker.evaluate('db.items.find({a:{$gt:1}}).toArray().length')
    expect(found.ok && num(found.value)).toBe(2)
    const sum = await worker.evaluate(
      'db.items.aggregate([{$group:{_id:null,s:{$sum:"$a"}}}]).toArray()[0].s',
    )
    expect(sum.ok && num(sum.value)).toBe(6)
    const loop = await worker.evaluate('let x = 0; for (let i = 0; i < 5; i++) x += i; x')
    expect(loop.ok && num(loop.value)).toBe(10)
    const count = await worker.evaluate('db.items.countDocuments()')
    expect(count.ok && num(count.value)).toBe(3)
    const dbs = await worker.evaluate('show dbs')
    expect(dbs.ok).toBe(true)
  })

  it(
    'stops a synchronous infinite loop at the command budget and keeps working',
    async () => {
      const worker = await connected('shop', 800)
      const stuck = await worker.evaluate('while(true){}')
      expect(stuck.ok).toBe(false)
      expect(stuck.ok === false && stuck.message).toMatch(/timed out|Script execution/i)
      // The worker still answers afterwards.
      const ok = await worker.evaluate('1 + 1')
      expect(ok.ok && num(ok.value)).toBe(2)
    },
    slow(20_000),
  )

  it('reports the current database with done, after use too (final review M6)', async () => {
    const worker = await connected('shop')
    // This helper's URI has no database path, so the shell starts on "test" (the manager adds the path).
    worker.send({ type: 'eval', id: 7, code: '1' })
    expect(await worker.next('done')).toMatchObject({ id: 7, db: 'test' })
    worker.send({ type: 'eval', id: 8, code: 'use other' })
    expect(await worker.next('done')).toMatchObject({ id: 8, db: 'other' })
    // Code cannot make it report something else by shadowing db.
    worker.send({ type: 'eval', id: 9, code: 'var db = { getName: () => "x", _name: "x" }; 1' })
    expect(await worker.next('done')).toMatchObject({ id: 9, db: 'other' })
  })

  it('unwraps only a real cursor batch, not an object that looks like one (final review M4)', async () => {
    const worker = await connected('shop')
    const lookalike = await worker.evaluate('({ cursorHasMore: true, documents: [1] })')
    // The object is shown as written, not taken for a batch of one document.
    expect(lookalike.ok && lookalike.value).toMatchObject({ cursorHasMore: true })
  })
})

/** Every message of one command, in order, up to its done. */
function messagesOf(
  worker: TestWorker,
  id: number,
  code: string,
  after?: () => void,
): Promise<WorkerToShell[]> {
  return new Promise((resolve) => {
    const seen: WorkerToShell[] = []
    const on = (m: WorkerToShell) => {
      if (!('id' in m) || m.id !== id) return
      seen.push(m)
      if (m.type === 'done') {
        worker.child.off('message', on)
        resolve(seen)
      }
    }
    worker.child.on('message', on)
    worker.send({ type: 'eval', id, code })
    after?.()
  })
}

// User report 2026-10-12: an aggregation pasted after `use shop` never ran — mongosh took it for
// `use`'s words. A script runs as mongosh runs what is typed: a piece at a time.
describe('shell worker: a script of many lines', () => {
  it('runs it piece by piece, each result named by its piece', async () => {
    const worker = await connected('shop')
    const code =
      'use other\ndb.scripted.deleteMany({})\ndb.scripted.insertOne({\n  a: 1,\n})\ndb.scripted.countDocuments()'
    const seen = await messagesOf(worker, 20, code)
    expect(seen.map((m) => m.type)).toEqual(['result', 'result', 'result', 'result', 'done'])
    const results = seen.filter((m) => m.type === 'result') as Array<
      Extract<WorkerToShell, { type: 'result' }>
    >
    expect(results.map((r) => r.command)).toEqual([
      'use other',
      'db.scripted.deleteMany({})',
      'db.scripted.insertOne({\n  a: 1,\n})',
      'db.scripted.countDocuments()',
    ])
    expect(num(results[3]!.value)).toBe(1)
    expect(seen.at(-1)).toMatchObject({ type: 'done', db: 'other' })
    // One piece: its result is not named (it is the command itself).
    const one = await messagesOf(worker, 21, 'db.scripted.countDocuments()')
    expect(one[0]).not.toHaveProperty('command')
  })

  it('stops at an error, saying how many pieces were left unrun', async () => {
    const worker = await connected('shop')
    const seen = await messagesOf(worker, 22, 'print("one")\nnope()\nprint("two")\nprint("three")')
    const printed = JSON.stringify(seen.filter((m) => m.type === 'print'))
    expect(printed).toContain('one')
    expect(printed).not.toContain('two')
    expect(seen.find((m) => m.type === 'error')).toMatchObject({ skipped: 2 })
    expect(seen.at(-1)?.type).toBe('done')
  })

  // Review 2026-10-12 (I12): `exit` closed the shell's MongoDB client and left it so.
  it('refuses exit, quit and cls, the shell working on after', async () => {
    const worker = await connected('shop')
    for (const [id, word] of [
      [23, 'exit'],
      [24, 'quit'],
      [25, 'cls'],
    ] as const) {
      const seen = await messagesOf(worker, id, word)
      expect(
        seen.find((m) => m.type === 'error'),
        word,
      ).toMatchObject({ message: expect.stringContaining(word) })
    }
    const after = await messagesOf(worker, 27, 'db.scripted.countDocuments() >= 0')
    expect(after[0]).toMatchObject({ type: 'result', value: true })
  })

  // Found 2026-10-12: print() and printjson() showed nothing — mongosh's print listener was never set.
  it('sends what the code prints, in order, many prints in few messages', async () => {
    const worker = await connected('shop')
    const seen = await messagesOf(
      worker,
      28,
      'for (let i = 0; i < 2000; i++) print("n" + i)\nprintjson({ a: 1 })',
    )
    const prints = seen.filter((m) => m.type === 'print') as Array<Extract<WorkerToShell, { type: 'print' }>>
    const text = prints.map((p) => p.text).join('\n')
    expect(text.split('\n').slice(0, 3)).toEqual(['n0', 'n1', 'n2'])
    expect(text).toContain('n1999')
    // printjson writes as results are written: shell syntax.
    expect(text).toMatch(/\{\s+a: 1\s+\}/)
    // Batched: far fewer messages than prints, however slowly the loop runs.
    expect(prints.length).toBeLessThan(2000 / 4)
    // The prints come before the command's end.
    expect(seen.at(-1)?.type).toBe('done')
  })

  it(
    'leaves what is left of a script unrun once asked to stop',
    async () => {
      const worker = await connected('shop')
      const seen = await messagesOf(worker, 26, 'sleep(1500)\nprint("after")\nprint("later")', () =>
        setTimeout(() => worker.send({ type: 'cancel', id: 26 }), 300),
      )
      expect(JSON.stringify(seen)).not.toContain('after')
      expect(seen.find((m) => m.type === 'error')).toMatchObject({ message: 'Stopped.', skipped: 2 })
    },
    slow(20_000),
  )
})

// Second review 2026-10-12.
describe('shell worker: a script of many lines, second review', () => {
  // I1: `exit()` written as a call closed the shell's client.
  it('refuses exit() and quit() as calls, the shell working on after', async () => {
    const worker = await connected('shop')
    for (const [id, code] of [
      [40, 'exit()'],
      [41, 'quit()'],
      [42, 'exit(1)'],
    ] as const) {
      const seen = await messagesOf(worker, id, code)
      expect(
        seen.some((m) => m.type === 'error'),
        code,
      ).toBe(true)
    }
    const after = await messagesOf(worker, 43, 'db.scripted.countDocuments() >= 0')
    expect(after[0]).toMatchObject({ type: 'result', value: true })
  })

  it('says which error the page words itself: a refused command, a stop, a closed connection', async () => {
    const worker = await connected('shop')
    const refused = await messagesOf(worker, 44, 'cls')
    expect(refused.find((m) => m.type === 'error')).toMatchObject({ code: 'NOT_AVAILABLE', message: 'cls' })
    const closed = await messagesOf(worker, 45, 'db.getMongo().close()\ndb.scripted.countDocuments()')
    expect(closed.find((m) => m.type === 'error')).toMatchObject({ code: 'DISCONNECTED' })
  })

  // Minor 23 and 6: prints as mongosh writes them; an empty print an empty line.
  it('prints values in shell syntax, a cursor as its documents, an empty print as an empty line', async () => {
    const worker = await connected('shop')
    await messagesOf(
      worker,
      46,
      'db.printed.deleteMany({})\ndb.printed.insertOne({ _id: 7, at: new Date(0) })',
    )
    const seen = await messagesOf(worker, 47, 'print(db.printed.find())\nprint()\nprint("end")')
    const text = (seen.filter((m) => m.type === 'print') as Array<Extract<WorkerToShell, { type: 'print' }>>)
      .map((p) => p.text)
      .join('\n')
    expect(text).toContain('ISODate("1970-01-01T00:00:00.000Z")')
    expect(text).not.toContain('cursorHasMore')
    expect(text).toMatch(/\n\nend$/)
  })

  // A declaration has no value: mongosh shows nothing, and no result goes to the page.
  it('sends no result for a statement with no value', async () => {
    const worker = await connected('shop')
    const seen = await messagesOf(worker, 48, 'const declared = 1')
    expect(seen.map((m) => m.type)).toEqual(['done'])
  })

  // Minor 8 and 9: a piece's name is its code, its secrets masked before it is cut.
  it('names each piece by its code, masked, the comments before it left out', async () => {
    const worker = await connected('shop')
    const seen = await messagesOf(
      worker,
      49,
      `// make a user\ndb.named.insertOne({ password: "${'s'.repeat(600)}" })\ndb.named.countDocuments()`,
    )
    const names = (
      seen.filter((m) => m.type === 'result') as Array<Extract<WorkerToShell, { type: 'result' }>>
    ).map((r) => r.command ?? '')
    expect(names[0]!.startsWith('db.named.insertOne')).toBe(true)
    expect(names[0]).not.toContain('sss')
    expect(names[1]).toBe('db.named.countDocuments()')
  })
})

describe('worker flags and environment (phase 3a-1 §3.1)', () => {
  it('uses only the sandbox flags', () => {
    const args = workerArgs('/path/to/worker.cjs', { netPermission: false })
    expect(args).toContain('--permission')
    expect(args).toContain('--allow-fs-read=/path/to/worker.cjs')
    expect(args).toContain('--disallow-code-generation-from-strings')
    expect(args).toContain('--max-old-space-size=256')
    expect(args.some((a) => a.startsWith('--allow-child-process'))).toBe(false)
    expect(args.some((a) => a.startsWith('--allow-worker'))).toBe(false)
    expect(args.some((a) => a.startsWith('--allow-fs-write'))).toBe(false)
    expect(args.some((a) => a.startsWith('--allow-addons'))).toBe(false)
    // Without the network permission (Node 24), no --allow-net is needed.
    expect(args).not.toContain('--allow-net')
  })

  it('allows the loopback proxy socket on a Node that enforces the network permission (review M1)', () => {
    // On Node 25+ --permission would block the worker's only socket (to the proxy); the in-process
    // network lock is the real egress control, so --allow-net keeps the shell working, not silent.
    const args = workerArgs('/path/to/worker.cjs', { netPermission: true })
    expect(args).toContain('--allow-net')
  })

  it('passes no environment beyond what the platform needs', () => {
    expect(workerEnv({ SECRET: 'x', PASSWORD: 'y', SystemRoot: 'C:\\Windows' }, 'linux')).toEqual({})
    expect(workerEnv({ SECRET: 'x', SystemRoot: 'C:\\Windows' }, 'win32')).toEqual({
      SystemRoot: 'C:\\Windows',
    })
  })

  it('a SEA worker (null bundle) gets no --allow-fs-read', () => {
    const args = workerArgs(null, { netPermission: false })
    expect(args).toContain('--permission')
    expect(args.some((a) => a.startsWith('--allow-fs-read'))).toBe(false)
  })
})

describe('the contextless-eval stub (phase 3a-1 §3.2)', () => {
  it('refuses any string other than mongosh runtime support', () => {
    const req = createRequire(import.meta.url)
    const stub = req('../src/shell/worker/contextless-eval.generated.cjs') as {
      contextlessEval: (code: string) => void
    }
    expect(() => stub.contextlessEval('return process')).toThrow(/host eval is disabled/)
    expect(() => stub.contextlessEval('1+1')).toThrow(/host eval is disabled/)
  })
})
