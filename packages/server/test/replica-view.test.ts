import { describe, expect, it } from 'vitest'
import { Long, Timestamp } from 'mongodb'
import { replicaView } from '../src/routes/data/server'

/** Phase 1j, final review Important 3: the mapping of replSetGetStatus, table by table. */
const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 10, 0, s))
const member = (over: object) => ({
  _id: 0,
  name: 'db0:27017',
  health: 1,
  stateStr: 'SECONDARY',
  optimeDate: at(0),
  uptime: 10,
  ...over,
})

describe('replicaView (final review 1j, Important 3)', () => {
  it('measures lag against the primary, and gives none to arbiters or down members', () => {
    const view = replicaView(
      {
        set: 'rs0',
        members: [
          member({ _id: 0, name: 'a', stateStr: 'PRIMARY', optimeDate: at(30) }),
          member({ _id: 1, name: 'b', optimeDate: at(18) }),
          member({ _id: 2, name: 'c', stateStr: 'ARBITER' }),
          member({ _id: 3, name: 'd', health: 0, stateStr: '(not reachable/healthy)' }),
        ],
      },
      null,
      null,
    )
    expect(view.members.map((m) => [m.name, m.lagSeconds])).toEqual([
      ['a', 0],
      ['b', 12],
      ['c', null],
      ['d', null],
    ])
    expect(view.primary).toBe('a')
  })

  it('computes no lag at all without a primary', () => {
    const view = replicaView({ members: [member({ name: 'b' }), member({ _id: 1, name: 'c' })] }, null, null)
    expect(view.primary).toBeNull()
    expect(view.members.every((m) => m.lagSeconds === null)).toBe(true)
  })

  it('gives no lag to a member still in initial sync, whose optime is the epoch (Important 2)', () => {
    const view = replicaView(
      {
        members: [
          member({ _id: 0, name: 'a', stateStr: 'PRIMARY', optimeDate: at(30) }),
          member({ _id: 1, name: 'b', stateStr: 'STARTUP2', optimeDate: new Date(0) }),
          member({ _id: 2, name: 'c', stateStr: 'RECOVERING', optimeDate: new Date(0) }),
          member({ _id: 3, name: 'd', stateStr: 'SECONDARY', optimeDate: new Date(0) }),
        ],
      },
      null,
      null,
    )
    expect(view.members.map((m) => m.lagSeconds)).toEqual([0, null, null, null])
  })

  it('takes priority, hidden and votes from the configuration by member id, not by host (Minor 6)', () => {
    const view = replicaView(
      { members: [member({ _id: 7, name: 'db-a.internal:27017' })] },
      { members: [{ _id: 7, host: 'db-a:27017', priority: 0, hidden: true, votes: 0 }] },
      null,
    )
    expect(view.members[0]).toMatchObject({ priority: 0, hidden: true, votes: 0 })
  })

  it('measures the majority commit lag from the primary’s last write, with timestamps of any shape (Minor 7)', () => {
    const view = replicaView(
      {
        members: [member({ _id: 0, name: 'a', stateStr: 'PRIMARY', optimeDate: at(30) })],
        optimes: { lastCommittedWallTime: at(26) },
      },
      null,
      null,
    )
    expect(view.majorityLagSeconds).toBe(4)
    const fallback = replicaView(
      {
        members: [],
        optimes: {
          appliedOpTime: { ts: new Timestamp({ t: 100, i: 1 }) },
          lastCommittedOpTime: { ts: Long.fromBits(1, 97) },
        },
      },
      null,
      null,
    )
    expect(fallback.majorityLagSeconds).toBe(3)
    expect(replicaView({ members: [] }, null, null).majorityLagSeconds).toBeNull()
  })

  // Widgets wave 2 (2026-10-27): replication headroom — how fast the oplog fills, the last election.
  it('says the oplog’s use and its rate over its window, and when the primary was elected', () => {
    const status = {
      set: 'rs0',
      members: [
        member({ _id: 0, name: 'a', stateStr: 'PRIMARY', optimeDate: at(30), electionDate: at(5) }),
        member({ _id: 1, name: 'b', optimeDate: at(18) }),
      ],
    }
    const view = replicaView(status, null, 10, { size: 5 * 1024 ** 3, maxSize: 50 * 1024 ** 3 })
    expect(view.lastElection).toBe(at(5).toISOString())
    expect(view.oplog).toEqual({ usedMb: 5 * 1024, maxMb: 50 * 1024, gbPerHour: 0.5 })
  })

  it('says no rate for an empty window, and no oplog or election where none is known', () => {
    const status = { members: [member({ stateStr: 'PRIMARY' })] }
    expect(replicaView(status, null, 0, { size: 1024 ** 2, maxSize: 2 * 1024 ** 2 }).oplog).toEqual({
      usedMb: 1,
      maxMb: 2,
      gbPerHour: null,
    })
    const none = replicaView(status, null, null, null)
    expect([none.oplog, none.lastElection]).toEqual([null, null])
    expect(replicaView(status, null, 5, { size: 'x' }).oplog).toBeNull()
  })
})
