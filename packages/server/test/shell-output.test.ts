// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Output } from '../src/shell/worker/output'
import { MAX_IPC_MESSAGE_BYTES, OUTPUT_CAP_BYTES, type WorkerToShell } from '../src/shell/ipc'

/** An Output whose sends are kept, on a clock the test moves. */
function output() {
  const sent: WorkerToShell[] = []
  let now = 0
  const waits: number[] = []
  const out = new Output({
    send: (m) => sent.push(m),
    now: () => now,
    wait: async (ms) => {
      waits.push(ms)
      now += ms
    },
    schedule: () => () => undefined,
  })
  return { out, sent, waits, tick: (ms: number) => (now += ms) }
}
const prints = (sent: WorkerToShell[]) =>
  sent.filter((m) => m.type === 'print') as Array<Extract<WorkerToShell, { type: 'print' }>>

/**
 * Second review 2026-10-12 (I2, I3): a print could pass the parent's 1 MiB message cap, and output
 * past the 5 MiB cap was still sent, passing its 1000 messages a second — the session was reset
 * either way. Output keeps every message under the caps.
 */
describe('a command’s output, within the parent’s caps', () => {
  it('sends prints together, one line each, an empty print an empty line', () => {
    const { out, sent } = output()
    out.begin(1)
    out.print('a')
    out.print('')
    out.print('b')
    out.flush()
    expect(prints(sent)).toEqual([{ type: 'print', id: 1, text: 'a\n\nb' }])
  })

  it('keeps each print message under the message cap, escaped as JSON, however the prints come', () => {
    const { out, sent } = output()
    out.begin(1)
    const control = String.fromCharCode(1)
    out.print(control.repeat(100_000))
    out.print(control.repeat(100_000))
    out.print('y'.repeat(400_000))
    out.flush()
    for (const m of prints(sent))
      expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(MAX_IPC_MESSAGE_BYTES)
    expect(
      prints(sent)
        .map((m) => m.text)
        .join(''),
    ).toContain(control.repeat(10))
  })

  it('stops sending output once past the output cap, the cap passed once so the parent says so', async () => {
    const { out, sent } = output()
    out.begin(1)
    for (let i = 0; i < 3000; i++) out.print('x'.repeat(140_000))
    for (let i = 0; i < 100; i++) await out.result({ resultType: null, value: 'v', hasMore: false })
    out.flush()
    const bytes = sent.reduce((n, m) => n + (m.type === 'print' ? Buffer.byteLength(m.text) : 0), 0)
    expect(bytes).toBeGreaterThan(OUTPUT_CAP_BYTES)
    expect(bytes).toBeLessThan(OUTPUT_CAP_BYTES + 200_000)
    expect(sent.filter((m) => m.type === 'result')).toHaveLength(0)
  })

  // Security audit 2026-10-16 (minor): a result was sent whole however large, and the parent parsed
  // it all (on its main thread) before it could refuse it.
  it('never sends a result too large for one message, and says the output was cut instead', async () => {
    const { out, sent } = output()
    out.begin(1)
    await out.result({ resultType: 'string', value: 'x'.repeat(MAX_IPC_MESSAGE_BYTES), hasMore: false })
    await out.result({ resultType: null, value: 'after', hasMore: false })
    out.print('later')
    out.flush()
    expect(sent).toEqual([{ type: 'truncated', id: 1 }])
  })

  it('never sends a result that would pass the output cap, counted in bytes', async () => {
    const { out, sent } = output()
    out.begin(1)
    // 400 000 two-byte characters: 800 000 bytes each, under the message cap; seven pass 5 MiB.
    for (let i = 0; i < 7; i++)
      await out.result({ resultType: 'string', value: 'ğ'.repeat(400_000), hasMore: false })
    const results = sent.filter((m) => m.type === 'result')
    expect(results.length).toBe(6)
    const bytes = results.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0)
    expect(bytes).toBeLessThanOrEqual(OUTPUT_CAP_BYTES)
    expect(sent.at(-1)).toEqual({ type: 'truncated', id: 1 })
    for (const m of sent) expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(MAX_IPC_MESSAGE_BYTES)
  })

  // Security review 2026-10-16 (I-6): the server refuses a message nested deeper than a document can
  // be; the worker holds such a result back instead of having its session reset.
  it('holds back a result nested too deeply for the server to take', async () => {
    const { out, sent } = output()
    out.begin(1)
    let deep: unknown = 1
    for (let i = 0; i < 600; i++) deep = [deep]
    await out.result({ resultType: null, value: deep, hasMore: false })
    expect(sent).toEqual([{ type: 'truncated', id: 1 }])
  })

  it('paces results under the parent’s message rate', async () => {
    const { out, sent, waits } = output()
    out.begin(1)
    for (let i = 0; i < 1200; i++) await out.result({ resultType: null, value: i, hasMore: false })
    expect(sent.filter((m) => m.type === 'result')).toHaveLength(1200)
    expect(waits.length).toBeGreaterThan(0)
  })

  it('sends nothing for a result with no value (mongosh shows nothing)', async () => {
    const { out, sent } = output()
    out.begin(1)
    await out.result({ resultType: null, value: undefined, hasMore: false })
    expect(sent).toHaveLength(0)
  })

  // Second review 2026-10-12 (minor 7): a print after a command's end went out under the next one.
  it('drops prints outside a command, and never carries one into the next', () => {
    const { out, sent } = output()
    out.print('before')
    out.begin(1)
    out.print('mine')
    out.end()
    out.print('late')
    out.begin(2)
    out.flush()
    expect(prints(sent)).toEqual([{ type: 'print', id: 1, text: 'mine' }])
  })
})
