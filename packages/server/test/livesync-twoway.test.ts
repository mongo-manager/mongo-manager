import { describe, expect, it } from 'vitest'
import { Binary, Timestamp, type Document } from 'mongodb'
import { before, changesOf, echoMark, lostKey, lsidOf, readEchoMark } from '../src/livesync/twoway'

/** W4 item 6: the two-way sync's pure parts — echoes by session mark, places, lost keys. */
const session = (hex: string) => ({ id: new Binary(Buffer.from(hex, 'hex'), 4) })
const ev = (op: string, id: number, t: number, extra: Document = {}): Document => ({
  _id: { _data: `tok-${t}` },
  operationType: op,
  clusterTime: new Timestamp({ t, i: 1 }),
  wallTime: new Date(t * 1000),
  documentKey: { _id: id },
  ...(op === 'delete' ? {} : { fullDocument: { _id: id, v: t } }),
  ...(op === 'insert' ? {} : { fullDocumentBeforeChange: { _id: id, v: t - 1 } }),
  ...extra,
})

describe('two-way changes (W4.6)', () => {
  const mine = 'aa'.repeat(16)
  const someone = 'bb'.repeat(16)

  it('leaves out the pair’s own writes by their session mark, and keeps everyone else’s', () => {
    const events = [
      ev('insert', 1, 10, { lsid: session(mine), txnNumber: 1 }),
      ev('update', 2, 11, { lsid: session(someone), txnNumber: 7 }),
      ev('delete', 3, 12),
      ev('createIndexes', 0, 13),
    ]
    expect(lsidOf(events[0]!)).toBe(mine)
    const { changes, echoes } = changesOf(events, new Map([[mine, 0]]), {
      token: { _data: 'start' },
      time: '9.1',
    })
    expect(echoes).toBe(1)
    expect(changes.map((c) => [c.op, c.id, c.at])).toEqual([
      ['update', 2, 11_000],
      ['delete', 3, 12_000],
    ])
    // Each change knows where its stream stood just before it (a restart holds there).
    expect(changes[0]!.before).toEqual({ token: { _data: 'tok-10' }, time: '10.1' })
    expect(changes[1]!.before).toEqual({ token: { _data: 'tok-11' }, time: '11.1' })
    expect(changes[1]!.post).toBeNull()
    expect(changes[1]!.pre).toEqual({ _id: 3, v: 11 })
  })

  // W4 review (minor): a pooled session id may have carried writes before the direction took it.
  it('takes for an echo only a transaction of the session after it was taken', () => {
    const events = [
      ev('update', 1, 10, { lsid: session(mine), txnNumber: 4 }),
      ev('update', 2, 11, { lsid: session(mine), txnNumber: 5 }),
      ev('update', 3, 12, { lsid: session(mine) }),
    ]
    const { changes, echoes } = changesOf(events, new Map([[mine, 4]]), null)
    expect(echoes).toBe(1)
    expect(changes.map((c) => c.id)).toEqual([1, 3])
    expect(changes[0]!.time).toBe('10.1')
    // Kept with the sync as "hex:txn"; a bare id (from before) takes any transaction.
    expect(readEchoMark(echoMark(mine, 4))).toEqual([mine, 4])
    expect(readEchoMark(mine)).toEqual([mine, -1])
  })

  it('reads a stream through the time before a change (a transaction may go on at the same time)', () => {
    expect(before('10.3')).toBe('10.2')
    expect(before('10.0')).toBe('9.4294967295')
  })

  it('remembers a lost change by a hash of its _id, never the _id itself', () => {
    expect(lostKey('a@example.com')).toMatch(/^[0-9a-f]{32}$/)
    expect(lostKey('a@example.com')).not.toContain('example')
    expect(lostKey(1)).not.toBe(lostKey('1'))
  })
})
