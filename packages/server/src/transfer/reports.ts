// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import type { TransferReport } from '@mongo-manager/shared'

/** Phase 3d-1 spec §6.3: job reports, owner-only, expiring with the transfer TTL. */
export class TransferReports {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  save(jobId: string, owner: string, report: TransferReport, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO transfer_reports (job_id, owner, report, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET report = excluded.report, expires_at = excluded.expires_at`,
      )
      .run(jobId, owner, JSON.stringify(report), expiresAt)
  }

  get(owner: string, jobId: string): TransferReport | undefined {
    const row = this.db
      .prepare('SELECT report FROM transfer_reports WHERE job_id = ? AND owner = ? AND expires_at > ?')
      .get(jobId, owner, this.now()) as { report: string } | undefined
    return row ? (JSON.parse(row.report) as TransferReport) : undefined
  }

  deleteAllFor(owner: string): void {
    this.db.prepare('DELETE FROM transfer_reports WHERE owner = ?').run(owner)
  }

  sweep(): void {
    this.db.prepare('DELETE FROM transfer_reports WHERE expires_at <= ?').run(this.now())
  }
}
