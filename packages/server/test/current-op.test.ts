// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import type { MongoClient } from 'mongodb'
import { listOperations } from '../src/jobs/current-op'
import { operationsMatch } from '../src/routes/data/server'

/** A client whose $currentOp answers as scripted, one answer per call. */
function fakeClient(answers: Array<'ok' | { code: number }>): { client: MongoClient; asked: boolean[] } {
  const asked: boolean[] = []
  const client = {
    db: () => ({
      aggregate: (pipeline: Array<{ $currentOp?: { allUsers: boolean } }>) => ({
        toArray: async () => {
          asked.push(pipeline[0]!.$currentOp!.allUsers)
          const answer = answers.shift()
          if (answer === 'ok') return [{ opid: 1 }]
          throw Object.assign(new Error('refused'), answer)
        },
      }),
    }),
  } as unknown as MongoClient
  return { client, asked }
}

describe('listOperations (final review M2)', () => {
  it('falls back to own operations only when MongoDB refuses the right', async () => {
    const refused = fakeClient([{ code: 13 }, 'ok'])
    expect(await listOperations(refused.client, {})).toEqual({ ops: [{ opid: 1 }], scope: 'own' })
    expect(refused.asked).toEqual([true, false])
  })

  it('reports any other failure instead of taking it for a missing role', async () => {
    const down = fakeClient([{ code: 6 }, 'ok'])
    await expect(listOperations(down.client, {})).rejects.toThrow('refused')
    // The next listing asks for every user's operations again.
    expect(await listOperations(down.client, {})).toEqual({ ops: [{ opid: 1 }], scope: 'all' })
  })
})

describe('operationsMatch (final review M1, phase 3b-2)', () => {
  it('leaves only our monitoring reads out, in MongoDB, before the limit, unless asked for', () => {
    const match = operationsMatch({}) as { $nor?: Array<Record<string, unknown>> }
    expect(match.$nor).toEqual([
      { 'command.comment': 'mm-monitor' },
      { 'cursor.originatingCommand.comment': 'mm-monitor' },
      { 'originatingCommand.comment': 'mm-monitor' },
    ])
    // A user's request through the app (mm:<id>) and a job (mm-job:<id>) are not excluded.
    expect(JSON.stringify(match)).not.toContain('mm[-:]')
    expect(operationsMatch({ own: true })).not.toHaveProperty('$nor')
  })

  it('shows our monitoring reads when asked, leaving out only the listing itself (final review M7)', () => {
    expect(operationsMatch({ own: true })).toEqual({
      'command.comment': { $ne: 'mm-monitor:ops' },
      active: true,
      op: { $ne: 'none' },
    })
  })
})
