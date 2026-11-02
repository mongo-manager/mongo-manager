import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { safeEqual } from '../http/security'

/**
 * One-time first-run setup token (spec §3.3). Lives in memory and, once the server keeps it there,
 * in a file of the data folder only the server's account reads — never in the log (security review
 * 2026-10-13: logs are often kept and read by others). The file goes once the setup is done.
 */
export class SetupState {
  private token: string | null = null
  private file: string | null = null

  /** Keeps the token in this file from now on (written with owner-only access). */
  keepIn(file: string): void {
    this.file = file
    if (!this.token) return
    // Made anew, never through what is there (a link someone left would be followed).
    rmSync(file, { force: true })
    writeFileSync(file, `${this.token}\n`, { mode: 0o600, flag: 'wx' })
  }

  get active(): boolean {
    return this.token !== null
  }

  ensureToken(): string {
    this.token ??= randomBytes(24).toString('base64url')
    return this.token
  }

  matches(candidate: string): boolean {
    return this.token !== null && safeEqual(candidate, this.token)
  }

  clear(): void {
    this.token = null
    // The token is spent either way; a file that cannot go now (held open, say) goes at the next
    // start, which finds users (review of the setup token, minor 5).
    try {
      if (this.file) rmSync(this.file, { force: true })
    } catch {
      // Left for the next start.
    }
  }
}
