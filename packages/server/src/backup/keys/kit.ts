// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { Errors } from '../../errors'

/** Phase 3d-3c spec §1.1: a backup key is 32 random bytes. */
export const KEY_BYTES = 32
export const KIT_PREFIX = 'MMKEY1-'
/** D7: kit text is read only up to this size. */
export const MAX_KIT_TEXT = 8192
/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Plan ruling 7: 256 key bits padded with 4 zero bits, then one check group. */
const BODY_CHARS = 52
const CHECK_CHARS = 4

export class KitError extends Error {
  override name = 'KitError'
  constructor(
    readonly reason: 'kit_format' | 'kit_checksum',
    message: string,
  ) {
    super(message)
  }
}

/** Spec §1.1: `K-` and the first 8 hex characters of the key's SHA-256. */
export const backupKeyFingerprint = (key: Buffer): string =>
  `K-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`

function encode(bytes: Buffer): string {
  let out = ''
  let value = 0
  let bits = 0
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xfff
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Exactly `length` bytes with zero padding bits after them, or null. */
function decode(text: string, length: number): Buffer | null {
  const out: number[] = []
  let value = 0
  let bits = 0
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    value = ((value << 5) | v) & 0xfff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (out.length !== length || (value & ((1 << bits) - 1)) !== 0) return null
  return Buffer.from(out)
}

/** Plan ruling 7: the top 20 bits of the key's CRC-32, as four characters. */
export function kitCheckGroup(key: Buffer): string {
  const crc = crc32(key) >>> 12
  return [15, 10, 5, 0].map((shift) => ALPHABET[(crc >>> shift) & 31]).join('')
}

/** `MMKEY1-` and 14 groups of 4: 13 for the key, the last one its checksum. */
export function kitLine(key: Buffer): string {
  return KIT_PREFIX + (encode(key) + kitCheckGroup(key)).match(/.{4}/g)!.join('-')
}

/** Hand typing: case, spaces and dashes do not matter; O reads as 0, I and L as 1. */
export const normaliseKitChars = (text: string): string =>
  text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

/** D7: the key of a kit's text (the last `MMKEY1-` line), strictly bounded; never echoes the text. */
export function parseKit(text: string): Buffer {
  if (typeof text !== 'string' || text.length > MAX_KIT_TEXT)
    throw new KitError('kit_format', 'This is not a recovery kit')
  const upper = text.toUpperCase()
  const at = upper.lastIndexOf(KIT_PREFIX)
  if (at < 0) throw new KitError('kit_format', 'No MMKEY1- key was found in this text')
  const chars = normaliseKitChars(upper.slice(at + KIT_PREFIX.length).split(/\r?\n/)[0]!)
  if (chars.length !== BODY_CHARS + CHECK_CHARS)
    throw new KitError('kit_format', 'The key has the wrong length: a group is missing or extra')
  const key = decode(chars.slice(0, BODY_CHARS), KEY_BYTES)
  if (!key) throw new KitError('kit_format', 'The key holds characters a recovery kit never has')
  if (chars.slice(BODY_CHARS) !== kitCheckGroup(key)) {
    key.fill(0)
    throw new KitError('kit_checksum', 'The key does not match its checksum: a character was mistyped')
  }
  return key
}

// eslint-disable-next-line no-control-regex -- control characters are what is removed here
const CONTROL = /[\u0000-\u001f\u007f]/g
/** A kit line never breaks, and never holds a second key line. */
const clean = (s: string) =>
  s
    .replace(CONTROL, ' ')
    .replace(/MMKEY1-/gi, '')
    .slice(0, 255)

/** Spec §1.1: the text shown once and downloaded; its key line is what opens the backups. */
export function kitText(k: {
  host: string
  username: string
  name: string
  fingerprint: string
  createdAt: number
  key: Buffer
}): string {
  return [
    'Mongo Manager — backup key recovery kit',
    '',
    'Keep this kit offline: printed, or in a password manager. With it, the backups made with this key',
    'open anywhere, even without this server. Anyone who holds it can open those backups.',
    '',
    `Installation: ${clean(k.host)}`,
    `User:         ${clean(k.username)}`,
    `Key:          ${clean(k.name)}`,
    `Fingerprint:  ${k.fingerprint}`,
    `Created:      ${new Date(k.createdAt).toISOString().slice(0, 10)}`,
    '',
    kitLine(k.key),
    '',
    'To open a backup without this server:',
    '  mongo-manager backup decrypt <file.mmbak> --key-file <this file> -o <file.archive>',
    '',
  ].join('\n')
}

export const kitFileName = (fingerprint: string): string => `mongo-manager-backup-key-${fingerprint}.txt`

/** D7: a kit given with a request; one that does not parse is a 400 with its reason, never echoing it. */
export function kitFrom(text: string): Buffer {
  try {
    return parseKit(text)
  } catch (e) {
    if (e instanceof KitError) throw Errors.validation(e.message, { reason: e.reason })
    throw e
  }
}
