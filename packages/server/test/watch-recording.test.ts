// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { WatchEvent } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../src/store/migrations'
import { TransferFiles } from '../src/transfer/files'
import { LabelledRecording, WatchRecorder, RECORDING_JOB, recordingJob } from '../src/changestreams/recording'

/** W4 item 7: a feed's recording — bounded, in order, one file a recording, none without an event. */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const ev = (seq: number): WatchEvent =>
  ({ seq, op: 'insert', ns: { db: 'd', coll: 'c' }, clusterTime: 1, masked: false, bytes: 10 }) as WatchEvent

describe('a feed’s recording (W4.7)', () => {
  it('writes events in order, stops when full (once said), and completes what it holds', async () => {
    const t = await makeApp()
    apps.push(t)
    const files = t.app.ctx.transfer.files
    let full = 0
    const feedId = randomUUID()
    const r = new WatchRecorder(files, {
      owner: 'local',
      connectionId: 'c1',
      feedId,
      namespace: 'd.c',
      masked: false,
      rulesVersion: null,
      startedAt: 1_700_000_000_000,
      onFull: () => full++,
      maxBytes: 300,
    })
    r.append([ev(1), ev(2)])
    r.append([ev(3)])
    for (let i = 4; i < 20; i++) r.append([ev(i)])
    await r.finish()
    expect(full).toBe(1)
    const file = files.byJob('local', recordingJob(feedId, 1_700_000_000_000), 'export')!
    expect(RECORDING_JOB.test(file.jobId!)).toBe(true)
    expect(file.complete).toBe(true)
    expect(file.size).toBeLessThanOrEqual(300)
    const seqs = readFileSync(files.pathOf(file), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as WatchEvent).seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    // Appends after the end are dropped.
    r.append([ev(99)])
    expect(readFileSync(files.pathOf(file), 'utf8')).not.toContain('"seq":99')
  })

  it('makes no file for a feed that sent nothing', async () => {
    const t = await makeApp()
    apps.push(t)
    const files = t.app.ctx.transfer.files
    const feedId = randomUUID()
    const r = new WatchRecorder(files, {
      owner: 'local',
      connectionId: 'c1',
      feedId,
      namespace: null,
      masked: false,
      rulesVersion: null,
      startedAt: 5,
      onFull: () => undefined,
    })
    await r.finish()
    expect(files.byJob('local', recordingJob(feedId, 5), 'export')).toBeUndefined()
  })
})

// W4 review I8: a file's "masked" label is what its events were sent as.
describe('a recording whose masking changes mid-feed (W4 review I8)', () => {
  it('starts a new file under the new label, never mixing the two', async () => {
    const t = await makeApp()
    apps.push(t)
    const files = t.app.ctx.transfer.files
    let label: { masked: boolean; rulesVersion: number | null } = { masked: true, rulesVersion: 3 }
    let clock = 1_700_000_000_000
    const rec = new LabelledRecording(files, {
      owner: 'local',
      connectionId: 'c9',
      feedId: randomUUID(),
      namespace: 'd.c',
      onFull: () => undefined,
      label: () => label,
      now: () => clock++,
    })
    rec.append([ev(1)])
    // The viewer may see personal values now: what follows goes out unmasked.
    label = { masked: false, rulesVersion: null }
    rec.append([ev(2)])
    rec.append([ev(3)])
    // New rules: masked again, under another version.
    label = { masked: true, rulesVersion: 4 }
    rec.append([ev(4)])
    await rec.finish()
    const made = files
      .listFor('local', 'c9')
      .sort((a, b) => (a.jobId! < b.jobId! ? -1 : 1))
      .map((f) => ({
        masked: f.masked,
        rulesVersion: f.rulesVersion,
        complete: f.complete,
        seqs: readFileSync(files.pathOf(f), 'utf8')
          .trim()
          .split('\n')
          .map((l) => (JSON.parse(l) as WatchEvent).seq),
      }))
    expect(made).toEqual([
      { masked: true, rulesVersion: 3, complete: true, seqs: [1] },
      { masked: false, rulesVersion: null, complete: true, seqs: [2, 3] },
      { masked: true, rulesVersion: 4, complete: true, seqs: [4] },
    ])
  })
})

// W4 review (minor): two recordings of one owner cannot both take the last of their space.
describe('recordings and the owner’s space', () => {
  it('claim room before writing, so two at once never pass the quota', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-rec-'))
    const db = new DatabaseSync(':memory:')
    for (const m of MIGRATIONS) db.exec(m.sql)
    try {
      const files = new TransferFiles(
        db,
        join(dir, 't'),
        { maxUpload: 1000, quota: 1000, ttlMs: 1000, maxJobMs: 1000 },
        () => 1,
      )
      files.init()
      const big = { ...ev(1), pad: 'x'.repeat(550) } as unknown as WatchEvent
      let full = 0
      const make = (startedAt: number) =>
        new WatchRecorder(files, {
          owner: 'u1',
          connectionId: 'c1',
          feedId: randomUUID(),
          namespace: null,
          masked: false,
          rulesVersion: null,
          startedAt,
          onFull: () => full++,
        })
      const a = make(1)
      const b = make(2)
      a.append([big])
      b.append([big])
      await Promise.all([a.finish(), b.finish()])
      expect(full).toBe(1)
      expect(files.usage('u1')).toBeLessThanOrEqual(1000)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
