// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DestinationSummary } from '@mongo-manager/shared/browser'

export type Verification = 'readBack' | 'checksum' | 'size'

/**
 * Phase 3d-3b final review C27: how a destination's upload is verified before it counts as sent —
 * every copy's size; a checksum where the provider reports one (S3, Drive); the whole file read back
 * for a server folder, and for WebDAV with "Verify by reading back" on. The server says which
 * (DestinationSummary.verify, final review B34); a summary without it falls back on the type, a
 * WebDAV destination counting as size-only (its read-back setting is not shown to users).
 */
export function verificationOf(d: DestinationSummary): Verification {
  if (d.verify) return d.verify
  if (d.type === 'folder') return 'readBack'
  if (d.type === 's3' || d.type === 'gdrive') return 'checksum'
  return 'size'
}
