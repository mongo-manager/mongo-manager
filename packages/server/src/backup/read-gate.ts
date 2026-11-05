// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../errors'

/**
 * Security review 2026-10-13 (M4): reading a backup to inspect it or plan its restore holds what it
 * decrypts and unpacks — an encrypted part is up to 128 MiB, so hundreds of megabytes a read. One
 * such read per owner, and a few on the whole server; the others are asked to wait.
 */
export class BackupReadGate {
  private total = 0
  private readonly owners = new Map<string, number>()

  constructor(
    private readonly perOwner = 1,
    private readonly max = 3,
  ) {}

  /** Takes a slot for `owner`; the returned function gives it back (once). */
  enter(owner: string): () => void {
    if ((this.owners.get(owner) ?? 0) >= this.perOwner || this.total >= this.max)
      throw Errors.rateLimited(2_000, 'backup_read_busy')
    this.total++
    this.owners.set(owner, (this.owners.get(owner) ?? 0) + 1)
    let left = false
    return () => {
      if (left) return
      left = true
      this.total--
      const n = (this.owners.get(owner) ?? 1) - 1
      if (n <= 0) this.owners.delete(owner)
      else this.owners.set(owner, n)
    }
  }
}
