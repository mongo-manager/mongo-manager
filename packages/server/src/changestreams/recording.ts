// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { appendFile, stat } from 'node:fs/promises'
import { MAX_WATCH_RECORDING_BYTES, type WatchEvent } from '@mongo-manager/shared'
import type { TransferFile, TransferFiles } from '../transfer/files'

/** W4.7: a recording's file job id: the feed and when it began (a reconnect records anew). */
export const recordingJob = (feedId: string, startedAt: number) =>
  // W4 review (minor): a feed id may come in capitals (z.uuid() takes them); kept in small letters.
  `watch:${feedId.toLowerCase()}:${startedAt}`
export const RECORDING_JOB = /^watch:[0-9a-f-]{36}:\d{1,16}$/

/**
 * W4.7 (completion design §2 W4.7): a feed's events recorded to a file, as its viewer was sent
 * them — masked where they were masked — one event per line (NDJSON), to replay on the Watch page or
 * download. The file is the viewer's own transfer file (the 3d-1 quota, owner and time-to-live
 * rules), bounded at 64 MiB; once full, recording stops (the feed goes on) and the file keeps what it
 * has. Writes are queued in order, never in parallel.
 */
export class WatchRecorder {
  private file: TransferFile | undefined
  private bytes = 0
  private chain: Promise<void> = Promise.resolve()
  private done = false
  full = false

  constructor(
    private readonly files: TransferFiles,
    private readonly input: {
      owner: string
      connectionId: string
      feedId: string
      namespace: string | null
      masked: boolean
      rulesVersion: number | null
      startedAt: number
      onFull(): void
      maxBytes?: number
    },
  ) {}

  append(events: WatchEvent[]): void {
    if (this.full || this.done || events.length === 0) return
    const text = events.map((e) => `${JSON.stringify(e)}\n`).join('')
    const size = Buffer.byteLength(text)
    const max = this.input.maxBytes ?? MAX_WATCH_RECORDING_BYTES
    if (this.bytes + size > max || !this.files.claim(this.input.owner, size)) {
      this.full = true
      this.input.onFull()
      return
    }
    this.bytes += size
    const bytes = this.bytes
    this.chain = this.chain
      .then(async () => {
        try {
          await this.write(text, bytes)
        } finally {
          // Counted in the file's size now (or never written): the claim goes.
          this.files.release(this.input.owner, size)
        }
      })
      .catch(() => {
        // A disk that refuses: recording stops, the feed goes on.
        this.full = true
      })
  }

  /** W4 review I8: what the recording's events were sent as (its file says so). */
  get label(): { masked: boolean; rulesVersion: number | null } {
    return { masked: this.input.masked, rulesVersion: this.input.rulesVersion }
  }

  private async write(text: string, bytes: number): Promise<void> {
    if (!this.file) {
      const stamp = new Date(this.input.startedAt).toISOString().slice(0, 19).replace(/[-:]/g, '')
      this.file = this.files.reserve({
        owner: this.input.owner,
        kind: 'export',
        growing: true,
        connectionId: this.input.connectionId,
        name: `watch-${this.input.namespace ?? 'deployment'}-${stamp}`,
        jobId: recordingJob(this.input.feedId, this.input.startedAt),
        ...(this.input.namespace ? { namespace: this.input.namespace } : {}),
        format: 'ndjson',
        masked: this.input.masked,
        rulesVersion: this.input.rulesVersion,
      }).file
    }
    await appendFile(this.files.pathOf(this.file), text, { mode: 0o600 })
    this.files.touch(this.file.id, bytes)
  }

  /** The feed ended or left its socket: the file is complete (none was made without an event). */
  async finish(): Promise<void> {
    if (this.done) return
    this.done = true
    await this.chain
    if (!this.file) return
    // What is on disk (a write that failed left less than was counted).
    const size = await stat(this.files.pathOf(this.file)).then(
      (s) => s.size,
      () => this.bytes,
    )
    this.files.complete(this.file.id, size)
  }
}

type Label = { masked: boolean; rulesVersion: number | null }

/**
 * W4 review I8: a feed's recording that keeps its label true. Before each batch the label is read as
 * the batch was sent — whether the viewer's events are masked, under which rules — and when it is no
 * longer the file's, that file is finished and a new one begun under the new label: a file marked
 * "masked" never holds an unmasked event, nor one masked under other rules.
 */
export class LabelledRecording {
  private current: WatchRecorder | null = null
  private last = 0
  /** Files finished on a change of label, still being closed. */
  private readonly ending: Array<Promise<void>> = []

  constructor(
    private readonly files: TransferFiles,
    private readonly input: {
      owner: string
      connectionId: string
      feedId: string
      namespace: string | null
      onFull(): void
      label(): Label
      now(): number
    },
  ) {}

  append(events: WatchEvent[]): void {
    if (events.length === 0) return
    const label = this.input.label()
    const was = this.current?.label
    if (this.current && (was!.masked !== label.masked || was!.rulesVersion !== label.rulesVersion)) {
      this.ending.push(this.current.finish())
      this.current = null
    }
    if (!this.current) {
      // A new file's job id holds when it began: never the same one twice.
      this.last = Math.max(this.last + 1, this.input.now())
      this.current = new WatchRecorder(this.files, {
        owner: this.input.owner,
        connectionId: this.input.connectionId,
        feedId: this.input.feedId,
        namespace: this.input.namespace,
        masked: label.masked,
        rulesVersion: label.rulesVersion,
        startedAt: this.last,
        onFull: this.input.onFull,
      })
    }
    this.current.append(events)
  }

  async finish(): Promise<void> {
    await Promise.all([...this.ending, this.current?.finish()])
  }
}
