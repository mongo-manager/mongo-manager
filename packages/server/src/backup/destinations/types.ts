// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Readable } from 'node:stream'
import { EgressError, type EgressReason } from '../../net/egress'

/** Phase 3d-3b spec §2.1: a completed kept backup, as an adapter sends it. */
export interface LocalFile {
  path: string
  size: number
  sha256: string
  md5: string
}
export interface RemoteStat {
  size: number
  sha256?: string
  md5?: string
  archived: boolean
  /** W4.5: an archived object's thaw — none asked, under way, or done (readable until it expires). */
  thaw?: ThawState
  ref?: string
}
export interface RemoteItem {
  key: string
  size: number
  modifiedAt: number | null
  archived: boolean
  ref?: string
}
/** Adapter-specific (an S3 upload id with its parts, a Drive session, a Nextcloud chunk folder); sealed at rest. */
export type ResumeState = Record<string, unknown>
export interface PutIo {
  progress(sent: number): void
  saveResume(state: ResumeState | null): void
}
export interface PutResult {
  ref?: string
  checksums?: { sha256?: string; md5?: string }
}

export interface DestinationAdapter {
  /** The address the resolve and connect test steps check; null for a local folder. */
  endpoint(): URL | null
  /**
   * W4.5: the resolve and connect test steps of a destination that is not https (SFTP: a judged TCP
   * connection); absent, the egress probes endpoint() with a HEAD request.
   */
  probe?(signal: AbortSignal): Promise<{ resolveMs: number; connectMs: number }>
  caPem(): string | undefined
  /** True when a send reads the whole object back to verify it (folder; WebDAV when configured). */
  readonly readBack: boolean
  /** Signs in and reaches the layout's root; Drive answers the account's e-mail. */
  authCheck(signal: AbortSignal): Promise<{ account?: string }>
  put(
    key: string,
    file: LocalFile,
    resume: ResumeState | null,
    io: PutIo,
    signal: AbortSignal,
  ): Promise<PutResult>
  putSmall(key: string, body: Buffer, signal: AbortSignal): Promise<void>
  stat(key: string, signal: AbortSignal): Promise<RemoteStat | null>
  get(key: string, offset: number, signal: AbortSignal): Promise<Readable>
  getSmall(key: string, limit: number, signal: AbortSignal): Promise<Buffer | null>
  /** One page of the layout's objects (not manifests), newest first where the provider allows. */
  list(cursor: string | null, signal: AbortSignal): Promise<{ items: RemoteItem[]; cursor: string | null }>
  remove(key: string, signal: AbortSignal): Promise<void>
  abandon(resume: ResumeState, signal: AbortSignal): Promise<void>
  /**
   * W4.5: asks the provider to thaw an archived object for `days` (S3 RestoreObject); answers the
   * thaw's state after the request. Absent where a provider has nothing to thaw.
   */
  thaw?(
    key: string,
    opts: { days: number; tier: ThawTier },
    signal: AbortSignal,
  ): Promise<{ state: ThawState }>
}

export type ThawState = 'none' | 'thawing' | 'thawed'
export type ThawTier = 'Expedited' | 'Standard' | 'Bulk'

export type DestinationReason =
  | EgressReason
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'bucket'
  | 'archived'
  | 'clock'
  | 'conflict'
  | 'provider'
  | 'verify'
  | 'reconnect'
  | 'secrets_missing'
  // Short names review 14 (M2): the destination itself is gone (not an object at it).
  | 'destination_deleted'
  // Short names review 7 (M-1): a credential that cannot be read (a malformed service account key).
  | 'secrets_invalid'
  | 'path'
  // Short names review 5 (M-4): a folder name Windows tools cannot handle (folder destinations).
  | 'path_name'
  | 'quota'
  // W4.5: a thaw asked of an object that is not archived, or of a destination that cannot thaw.
  | 'not_archived'
  // W4.5 (SFTP): no host key pinned yet, or the server showed another one than the pinned key.
  | 'host_key'
  | 'host_key_changed'

export class DestinationError extends Error {
  override name = 'DestinationError'
  constructor(
    readonly reason: DestinationReason,
    message: string,
    readonly extra: {
      status?: number
      code?: string
      retryAfterMs?: number
      hostKey?: string
      /** Short names review 6 (I-1): the folder name a path_name refusal is about, quoted. */
      name?: string
      /** Short names review 7 (I-1): which folder refusal a `path` one is (folder.ts WHY). */
      why?: string
    } = {},
  ) {
    super(message)
  }
}

/**
 * Phase 3d-3b final review (A15): a size a provider reports — a non-negative safe integer, else null
 * (unknown). Never NaN or negative: a fetch must not "finish" an upload of -1 bytes.
 */
export function sizeOf(v: unknown): number | null {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (!/^\d{1,16}$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** An offset cursor of a listing gathered whole (folder, WebDAV, Drive, S3); anything else is 0. */
export function offsetOf(cursor: string | null): number {
  return cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
}

export function toDestinationError(e: unknown): DestinationError {
  if (e instanceof DestinationError) return e
  if (e instanceof EgressError)
    return new DestinationError(e.reason, e.message, e.detail ? { code: e.detail } : {})
  return new DestinationError('provider', 'The destination failed')
}
