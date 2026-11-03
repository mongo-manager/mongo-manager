import { appendFile, stat } from 'node:fs/promises'
import { EJSON, type Document } from 'bson'
import type { TransferFiles, TransferFile } from '../transfer/files'
import type { LiveSyncRecord } from './repo'

/**
 * W4.6 (completion design §2 W4.6; phase 3e-2 spec §1.7): the documents a "skip and record" sync's
 * target refused, kept in a rejected-records file as 3d-1 writes them — one document per line, in
 * canonical Extended JSON, exactly as the sync tried to write it (masked when the sync masks). One
 * file per sync, owned by the sync's owner, counted against that owner's transfer space; it grows
 * while the sync runs and lives the transfer files' time after its last record.
 *
 * - A record that would pass the owner's space is not written (the sync still skips the document and
 *   logs its `_id` and code); the file keeps what it has.
 * - A masked sync's file is bound to the source's rules version it was masked under: records masked
 *   under other rules start a new file (the old one is deleted), so one file never mixes them.
 */
export class LiveSyncRejected {
  constructor(private readonly files: TransferFiles) {}

  /** The sync's file, or undefined. */
  fileOf(r: Pick<LiveSyncRecord, 'id' | 'owner'>): TransferFile | undefined {
    return this.files.byJob(r.owner, r.id, 'rejected')
  }

  /** Appends documents; how many were written (0 when the owner's space is full). */
  async append(r: LiveSyncRecord, docs: Document[]): Promise<number> {
    if (!docs.length) return 0
    const version = r.options.masked ? r.stamps.versions.source : null
    let file = this.fileOf(r)
    if (file && file.rulesVersion !== version) {
      this.files.delete(r.owner, file.id)
      file = undefined
    }
    const text = docs.map((d) => `${EJSON.stringify(d, { relaxed: false })}\n`).join('')
    const bytes = Buffer.byteLength(text)
    // The owner's space first: a record that would pass it is left out. W4 review (minor): claimed
    // at once, so another writer of the owner's (a recording) cannot take the same room meanwhile.
    if (!this.files.claim(r.owner, bytes)) return 0
    try {
      await this.write(r, file, version, text)
    } finally {
      this.files.release(r.owner, bytes)
    }
    return docs.length
  }

  private async write(
    r: LiveSyncRecord,
    found: TransferFile | undefined,
    version: number | null,
    text: string,
  ): Promise<void> {
    let file = found
    if (!file)
      file = this.files.reserve({
        owner: r.owner,
        kind: 'rejected',
        growing: true,
        connectionId: r.target.connectionId,
        name: `${r.name}-rejected`,
        jobId: r.id,
        namespace: r.target.coll ? `${r.target.db}.${r.target.coll}` : r.target.db,
        format: 'ndjson',
        masked: r.options.masked,
        rulesVersion: version,
      }).file
    const path = this.files.pathOf(file)
    await appendFile(path, text, { mode: 0o600 })
    this.files.touch(file.id, (await stat(path)).size)
  }

  /** The sync is gone: so is its file. */
  remove(r: Pick<LiveSyncRecord, 'id' | 'owner'>): void {
    const file = this.fileOf(r)
    if (file) this.files.delete(r.owner, file.id)
  }
}
