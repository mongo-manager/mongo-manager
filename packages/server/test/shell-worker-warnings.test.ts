import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { quietFlagWarnings } from '../src/shell/worker/warnings'

// Review of the SEA fix 2026-10-20 (minor 5): on Node 25+ --allow-net says it is experimental at
// every worker's start, which the server logged as the worker's stderr.
describe("the shell worker's warnings", () => {
  // Node's own printer (named as Node names it) stands in, recording what it is given.
  const run = () => {
    const proc = new EventEmitter()
    const written: unknown[] = []
    proc.on('warning', function onWarning(w: unknown) {
      written.push(w)
    })
    quietFlagWarnings(proc)
    return { proc, written }
  }
  const warning = (name: string, message: string) => Object.assign(new Error(message), { name })

  it('leaves out the one about --allow-net', () => {
    const { proc, written } = run()
    proc.emit('warning', warning('ExperimentalWarning', 'The flag --allow-net is under experimental phase.'))
    expect(written).toEqual([])
  })

  // Fourth review of the SEA fix 2026-10-20 (minor 1, 2): Node writes every other one itself.
  it("gives every other warning to Node's own printer, as it is", () => {
    const { proc, written } = run()
    const crypto = warning('ExperimentalWarning', 'The supports Web Crypto API method is experimental')
    const old = Object.assign(warning('DeprecationWarning', 'old'), { code: 'DEP0005', detail: 'Use x.' })
    const odd = Object.assign(warning('OddWarning', 'odd'), { toString: null })
    for (const w of [crypto, old, odd, null]) proc.emit('warning', w)
    expect(written).toEqual([crypto, old, odd, null])
  })

  // Fifth review of the SEA fix 2026-10-20 (minor 1): only Node's printer is wrapped; any other
  // listener stays as it was added (once, removable), and without Node's printer nothing changes.
  it("wraps Node's printer only", () => {
    const proc = new EventEmitter()
    const seen: string[] = []
    proc.on('warning', function onWarning() {
      seen.push('node')
    })
    proc.once('warning', () => seen.push('once'))
    const mine = () => seen.push('mine')
    proc.on('warning', mine)
    quietFlagWarnings(proc)
    proc.emit('warning', warning('DeprecationWarning', 'a'))
    proc.off('warning', mine)
    proc.emit('warning', warning('DeprecationWarning', 'b'))
    // Node's printer first, as Node added it (review of the CI fix 2026-10-20, nit).
    expect(seen).toEqual(['node', 'once', 'mine', 'node'])
  })

  it('changes nothing when Node writes no warnings (--no-warnings)', () => {
    const proc = new EventEmitter()
    const mine = () => undefined
    proc.on('warning', mine)
    quietFlagWarnings(proc)
    expect(proc.rawListeners('warning')).toEqual([mine])
  })
})
