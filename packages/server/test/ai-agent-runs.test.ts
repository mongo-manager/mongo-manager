import { describe, expect, it } from 'vitest'
import { AgentRuns } from '../src/ai/agent/runs'

const change = { callId: '1.1', connectionId: 'c1', run: async () => ({ state: 'declined' as const }) }

describe('runs waiting for a person (W6.3)', () => {
  // Security review of W6.3 (minor 1): a Stop while a confirmed change ran said "nothing was changed".
  it('a turn stopped while a confirmed change runs records how the change really ended', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    const waited = runs.wait('r', change)
    expect(runs.take('r', 'local', '1.1')).toBe(true)
    runs.close('r')
    let settled = false
    void waited.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(runs.finish('r', { state: 'done', summary: { created: 'db.c' }, result: {} })).toBe(true)
    expect(await waited).toMatchObject({ state: 'done' })
    // And the run is gone afterwards.
    expect(runs.pending('r', 'local', '1.1')).toBeNull()
  })

  it('a turn stopped before any answer cancels the change', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    const waited = runs.wait('r', change)
    runs.close('r')
    expect(await waited).toEqual({ state: 'cancelled' })
    expect(runs.take('r', 'local', '1.1')).toBe(false)
  })
})

// Design 2026-10-25 (C4): the backup a card makes before its change.
describe('a backup made before a change (C4)', () => {
  const backed = { ...change, backup: async () => ({ job: 'j' }) }
  const settledOf = (p: Promise<unknown>) => {
    const s = { done: false }
    void p.then(() => (s.done = true))
    return s
  }

  it('keeps the change waiting while its backup is made, then gives it its whole time again', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    const waited = runs.wait('r', backed, 40)
    const settled = settledOf(waited)
    expect(runs.startBackup('r', 'local', '1.1')).toBe(true)
    expect(runs.backingUp('r')).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(settled.done).toBe(false)
    runs.endBackup('r', '1.1', true)
    expect(runs.backingUp('r')).toBe(false)
    expect(await waited).toEqual({ state: 'expired' })
  })

  // Review of C4 (M3): a backup asked again and again never holds the card open.
  it('gives a change only the time it had left after a backup not made, and holds it a bounded while', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    const waited = runs.wait('r', backed, 60)
    const settled = settledOf(waited)
    await new Promise((r) => setTimeout(r, 40))
    expect(runs.startBackup('r', 'local', '1.1')).toBe(true)
    runs.endBackup('r', '1.1', false)
    await new Promise((r) => setTimeout(r, 40))
    expect(settled.done).toBe(true)
    expect(await waited).toEqual({ state: 'expired' })
    runs.open('s', 'local')
    const held = runs.wait('s', backed, 20)
    expect(runs.startBackup('s', 'local', '1.1')).toBe(true)
    // A backup that never ends: the card goes once its hold is over.
    expect(await held).toEqual({ state: 'expired' })
  })

  // Second review of C4 (M3): backups asked again and again hold the card for one bounded while in all.
  it('holds a card for all its backups together a bounded while', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    const waited = runs.wait('r', backed, 20)
    const settled = settledOf(waited)
    const began = Date.now()
    for (let i = 0; i < 6 && !settled.done; i++) {
      runs.startBackup('r', 'local', '1.1')
      await new Promise((r) => setTimeout(r, 40))
      runs.endBackup('r', '1.1', false)
    }
    expect(await waited).toEqual({ state: 'expired' })
    // Six times its time, and a little: never the 240 ms six holds of their own would give.
    expect(Date.now() - began).toBeLessThan(200)
  })

  it('makes one backup a change — again only when the first was not made — and none where none is offered', async () => {
    const runs = new AgentRuns()
    runs.open('r', 'local')
    void runs.wait('r', backed)
    expect(runs.startBackup('r', 'other', '1.1')).toBe(false)
    expect(runs.startBackup('r', 'local', '1.1')).toBe(true)
    expect(runs.startBackup('r', 'local', '1.1')).toBe(false)
    runs.endBackup('r', '1.1', false)
    expect(runs.startBackup('r', 'local', '1.1')).toBe(true)
    runs.endBackup('r', '1.1', true)
    expect(runs.startBackup('r', 'local', '1.1')).toBe(false)
    runs.close('r')
    runs.open('s', 'local')
    void runs.wait('s', change)
    expect(runs.startBackup('s', 'local', '1.1')).toBe(false)
    runs.close('s')
  })
})
