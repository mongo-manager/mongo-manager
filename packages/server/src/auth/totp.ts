import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_MS = 30_000

function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Invalid base32 secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', key).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return binary.toString().padStart(digits, '0')
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpCode(secret: string, timeMs: number, digits = 6): string {
  return hotp(base32Decode(secret), Math.floor(timeMs / STEP_MS), digits)
}

/** Accepts the previous, current and next 30 s step; steps at or before lastUsedStep are replays. */
export function verifyTotp(
  secret: string,
  code: string,
  timeMs: number,
  lastUsedStep?: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const current = Math.floor(timeMs / STEP_MS)
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== undefined && lastUsedStep !== null && step <= lastUsedStep) continue
    const expected = Buffer.from(hotp(key, step, 6))
    if (timingSafeEqual(expected, Buffer.from(code))) return step
  }
  return null
}

export function totpUri(secret: string, account: string, issuer = 'Mongo Manager'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
