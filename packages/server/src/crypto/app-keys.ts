// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from './secret-box'

/**
 * Security audit 2026-10-16: keys for keyed hashes that must stay checkable after a key rotation —
 * recovery codes (only their hash is kept, so they cannot be re-keyed) and the audit log's chain. A
 * key derived from the secret key would change with it; these are random, kept sealed with the
 * secret key in the settings table, and re-sealed by a rotation like any other secret.
 */
export type AppKeyPurpose = 'recovery-codes' | 'audit-chain'

const PURPOSES: readonly AppKeyPurpose[] = ['recovery-codes', 'audit-chain']
const settingOf = (purpose: AppKeyPurpose) => `app_key:${purpose}`
export const appKeyContext = (purpose: AppKeyPurpose) => `app-key:${purpose}`

/** The key for this purpose, made (and kept sealed) the first time it is asked for. */
export function appKey(db: DatabaseSync, box: SecretBox, purpose: AppKeyPurpose): Buffer {
  return appKeyState(db, box, purpose).key
}

/** The key, and whether this call made it (the audit chain begins with its key). */
export function appKeyState(
  db: DatabaseSync,
  box: SecretBox,
  purpose: AppKeyPurpose,
): { key: Buffer; created: boolean } {
  const read = () =>
    db.prepare('SELECT value FROM settings WHERE key = ?').get(settingOf(purpose)) as
      { value: string } | undefined
  let row = read()
  let created = false
  if (!row) {
    const sealed = box.seal(randomBytes(32).toString('base64'), appKeyContext(purpose))
    // Another process (an admin command beside the server) may have made it meanwhile: theirs stays.
    created =
      Number(
        db
          .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
          .run(settingOf(purpose), sealed).changes,
      ) === 1
    row = read()!
  }
  const key = Buffer.from(box.open(row.value, appKeyContext(purpose)), 'base64')
  if (key.length !== 32) throw new Error(`The ${purpose} key is damaged`)
  return { key, created }
}

/** The audit log of this store with its chain key (review of the audit fixes, important 4). */
export function auditChainKey(db: DatabaseSync, box: SecretBox): { key: Buffer; keyCreated: boolean } {
  const { key, created } = appKeyState(db, box, 'audit-chain')
  return { key, keyCreated: created }
}

/** Re-seals every app key with the new secret key (inside the rotation's transaction). */
export function resealAppKeys(db: DatabaseSync, oldBox: SecretBox, newBox: SecretBox): number {
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
  let count = 0
  for (const purpose of PURPOSES) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingOf(purpose)) as
      { value: string } | undefined
    if (!row) continue
    const context = appKeyContext(purpose)
    update.run(newBox.seal(oldBox.open(row.value, context), context), settingOf(purpose))
    count++
  }
  return count
}
