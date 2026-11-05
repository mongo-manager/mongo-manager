// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { redactUris } from '../connections/errors'
import { bare, isPlain, MASK } from './document'

/** Phase 3b spec §2.3: hidden for everyone, whatever the rules. Keys compared in lower case. */
const SECRET_KEYS = new Set([
  'pwd',
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'key',
  // Security audit 2026-10-16 (minor): SCRAM credentials (system.users, an oplog entry that writes one).
  'storedkey',
  'serverkey',
  'salt',
])
const SECRET_COMMANDS = new Set(['createuser', 'updateuser', 'authenticate', 'saslstart', 'saslcontinue'])

/** Whether redactSecrets would hide anything in this value (a connection string, a secret key). */
export function holdsSecret(value: unknown): boolean {
  if (typeof value === 'string') return redactUris(value) !== value
  if (Array.isArray(value)) return value.some(holdsSecret)
  if (!isPlain(value)) return false
  const keys = Object.keys(value)
  const first = keys[0]?.toLowerCase()
  if (first !== undefined && SECRET_COMMANDS.has(first)) return true
  return keys.some(
    (k) =>
      (SECRET_KEYS.has(k.toLowerCase()) && !(first === 'distinct' && k === 'key')) || holdsSecret(value[k]),
  )
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactUris(value)
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!isPlain(value)) return value
  const keys = Object.keys(value)
  const first = keys[0]
  if (first !== undefined && SECRET_COMMANDS.has(first.toLowerCase())) {
    const out = bare()
    out[first] = MASK
    return out
  }
  // The `key` of distinct is the field it reads, a name (final review M5).
  const distinct = first?.toLowerCase() === 'distinct'
  const out = bare()
  for (const k of keys) {
    const secret = SECRET_KEYS.has(k.toLowerCase()) && !(distinct && k === 'key')
    out[k] = secret ? MASK : redactSecrets(value[k])
  }
  return out
}
