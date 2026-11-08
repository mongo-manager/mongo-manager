// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Long } from 'bson'

// Go's hash/crc64 with the ECMA table: reflected polynomial, all-ones init and final XOR. The
// table is kept as two 32-bit halves so the per-byte loop never touches BigInt.
const POLY = 0xc96c5795d7870f42n
const LO = new Uint32Array(256)
const HI = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = BigInt(i)
  for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ POLY : c >> 1n
  LO[i] = Number(c & 0xffffffffn)
  HI[i] = Number(c >> 32n)
}

/** Phase 3d-3a spec §4.1: the CRC mongodump stores at the end of each namespace. */
export class Crc64 {
  private lo = 0xffffffff
  private hi = 0xffffffff

  update(buf: Uint8Array): void {
    let lo = this.lo
    let hi = this.hi
    for (let i = 0; i < buf.length; i++) {
      const idx = (lo ^ buf[i]!) & 0xff
      const nextLo = (LO[idx]! ^ ((lo >>> 8) | (hi << 24))) >>> 0
      hi = (HI[idx]! ^ (hi >>> 8)) >>> 0
      lo = nextLo
    }
    this.lo = lo
    this.hi = hi
  }

  digest(): bigint {
    return (BigInt(~this.hi >>> 0) << 32n) | BigInt(~this.lo >>> 0)
  }

  /** As mongodump stores it: a signed Int64. */
  signed(): Long {
    return Long.fromBigInt(BigInt.asIntN(64, this.digest()))
  }
}
