import { describe, expect, it } from 'vitest'
import { APP_EVENT_KINDS, type AppEvent } from '@mongo-manager/shared'
import { AppEvents } from '../src/events/app-events'

/**
 * W4 (completion design §2 W4.7, W3.3): the app-event hook other parts subscribe to (the alerts of
 * W3). Emitting never blocks or fails the emitter; what an event carries is bounded and never a
 * document value.
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('app events', () => {
  it('lists the kinds W4 emits', () => {
    expect([...APP_EVENT_KINDS]).toEqual(
      expect.arrayContaining([
        'backup.drill.passed',
        'backup.drill.failed',
        'liveSync.conflicts',
        'watch.matched',
      ]),
    )
  })

  it('hands each event to every listener after the emitter returned', async () => {
    const hub = new AppEvents(() => 1234)
    const got: AppEvent[] = []
    const off = hub.on((e) => void got.push(e))
    hub.emit('backup.drill.failed', {
      severity: 'critical',
      connectionId: 'c1',
      namespace: 'shop',
      ownerId: 'u1',
      summary: 'The restore drill of shop failed',
      details: { mismatched: 2, backup: 'b1' },
    })
    // Asynchronous: the emitter is never slowed by a listener.
    expect(got).toHaveLength(0)
    await tick()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      kind: 'backup.drill.failed',
      severity: 'critical',
      connectionId: 'c1',
      namespace: 'shop',
      ownerId: 'u1',
      details: { mismatched: 2, backup: 'b1' },
    })
    // W4 review I4: the context's clock.
    expect(got[0]!.at).toBe(1234)
    off()
    hub.emit('backup.drill.passed', { severity: 'info', summary: 'ok' })
    await tick()
    expect(got).toHaveLength(1)
  })

  it('never lets a listener fail the emitter or the other listeners', async () => {
    const hub = new AppEvents()
    const got: string[] = []
    hub.on(() => {
      throw new Error('boom')
    })
    hub.on(async () => {
      throw new Error('async boom')
    })
    hub.on((e) => void got.push(e.kind))
    expect(() => hub.emit('liveSync.conflicts', { severity: 'warning', summary: 's' })).not.toThrow()
    await tick()
    await tick()
    expect(got).toEqual(['liveSync.conflicts'])
  })

  it('bounds what an event carries: primitives only, cut texts, at most 20 details', async () => {
    const hub = new AppEvents()
    const got: AppEvent[] = []
    hub.on((e) => void got.push(e))
    const details: Record<string, unknown> = {
      nested: { secret: 'x' },
      list: [1, 2],
      fn: () => 1,
      long: 'y'.repeat(1000),
      ok: true,
      nil: null,
    }
    for (let i = 0; i < 30; i++) details[`k${i}`] = i
    hub.emit('watch.matched', {
      severity: 'info',
      summary: 'z'.repeat(1000),
      details: details as never,
    })
    await tick()
    const e = got[0]!
    expect(e.summary.length).toBeLessThanOrEqual(300)
    expect('nested' in e.details).toBe(false)
    expect('list' in e.details).toBe(false)
    expect('fn' in e.details).toBe(false)
    expect((e.details.long as string).length).toBeLessThanOrEqual(200)
    expect(e.details.ok).toBe(true)
    expect(e.details.nil).toBeNull()
    expect(Object.keys(e.details).length).toBeLessThanOrEqual(20)
  })

  it('ignores a kind it does not know (a typo never reaches the listeners)', async () => {
    const hub = new AppEvents()
    const got: AppEvent[] = []
    hub.on((e) => void got.push(e))
    hub.emit('nope' as never, { severity: 'info', summary: 'x' })
    await tick()
    expect(got).toHaveLength(0)
  })

  it('makes a details key named __proto__ data, never a prototype', async () => {
    const hub = new AppEvents()
    const got: AppEvent[] = []
    hub.on((e) => void got.push(e))
    hub.emit('watch.matched', {
      severity: 'info',
      summary: 'x',
      details: JSON.parse('{"__proto__": "p", "a": 1}') as never,
    })
    await tick()
    expect(Object.getPrototypeOf(got[0]!.details)).toBeNull()
    expect(({} as Record<string, unknown>).p).toBeUndefined()
  })
})

// W4 review I4: listeners belong to their server's context — no state shared between two servers.
describe('app events of two servers', () => {
  it('reach only the listeners of the server they happened on', async () => {
    const one = new AppEvents()
    const two = new AppEvents()
    const got: string[] = []
    one.on(() => void got.push('one'))
    two.on(() => void got.push('two'))
    one.emit('watch.matched', { severity: 'info', summary: 'x' })
    await tick()
    expect(got).toEqual(['one'])
  })
})
