// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ServerContext } from '../../http/context'

/**
 * Phase 3d-3c spec §1.1, D3: what may open a server slot for this caller — their own keys, looked up
 * by the slot's key id only (no other key is tried), or a kit given with the request.
 */
export interface SlotKeys {
  own(keyId: string): { key: Buffer; name: string } | null
  kit: Buffer | null
}

export function slotKeysFor(ctx: ServerContext, owner: string, kit: Buffer | null = null): SlotKeys {
  return {
    own: (keyId) => {
      const record = ctx.backup.keys.get(owner, keyId)
      const key = record ? ctx.backup.keys.open(owner, keyId) : null
      return record && key ? { key, name: record.name } : null
    },
    kit,
  }
}
