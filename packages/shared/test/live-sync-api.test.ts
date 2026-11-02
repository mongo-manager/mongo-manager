import { describe, expect, it } from 'vitest'
import { FINAL_STATES, LiveSyncRequestSchema, RUNNING_STATES } from '../src/index'

const collection = {
  source: { connectionId: 'a', db: 'shop', coll: 'orders' },
  target: { connectionId: 'b', db: 'shop', coll: 'orders' },
}

describe('live sync contracts (phase 3e-2 spec §1)', () => {
  it('fills the defaults: copy first, pause on errors, follow new collections, nothing confirmed', () => {
    expect(LiveSyncRequestSchema.parse(collection)).toMatchObject({
      startMode: 'copy',
      errorPolicy: 'pause',
      followNew: true,
      anonymous: false,
      confirmPersonal: false,
      confirmOverwrite: false,
      confirmOplog: false,
    })
  })

  it('takes a collection to a collection or a database to a database, nothing else', () => {
    expect(
      LiveSyncRequestSchema.safeParse({
        source: { connectionId: 'a', db: 'shop', collections: ['a', 'b'] },
        target: { connectionId: 'b', db: 'copy' },
      }).success,
    ).toBe(true)
    for (const bad of [
      { source: { connectionId: 'a', db: 'shop', coll: 'o' }, target: { connectionId: 'b', db: 'shop' } },
      { source: { connectionId: 'a', db: 'shop' }, target: { connectionId: 'b', db: 'shop', coll: 'o' } },
      {
        source: { connectionId: 'a', db: 'shop', coll: 'o', collections: ['o'] },
        target: { connectionId: 'b', db: 's', coll: 'o' },
      },
      // W4.6: a filter is a collection sync's only (a database sync carries whole collections).
      { source: { connectionId: 'a', db: 'shop' }, target: { connectionId: 'b', db: 'copy' }, filter: {} },
      { ...collection, startMode: 'later' },
      { ...collection, planHash: 'not-a-hash' },
    ])
      expect(LiveSyncRequestSchema.safeParse(bad).success).toBe(false)
  })

  it('names the running and the final states apart', () => {
    expect(RUNNING_STATES).toEqual(['copying', 'catching_up', 'live', 'retrying', 'cutting_over'])
    expect(FINAL_STATES).toEqual(['completed', 'failed', 'stopped'])
    expect(RUNNING_STATES.some((s) => (FINAL_STATES as readonly string[]).includes(s))).toBe(false)
  })
})
