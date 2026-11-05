// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** Minimal executables for the loader checks: just the headers the dynamic loader reads. */

export function elf64(opts: { interpreter?: string; needed?: string[]; runpath?: string } = {}): Buffer {
  const buf = Buffer.alloc(2048)
  const base = 0x400000
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = 2 // 64-bit
  buf[5] = 1 // little-endian
  buf[6] = 1
  buf.writeBigUInt64LE(64n, 0x20) // e_phoff
  buf.writeUInt16LE(56, 0x36) // e_phentsize
  const interpreter = opts.interpreter ?? '/lib64/ld-linux-x86-64.so.2'
  buf.write(`${interpreter}\0`, 256)
  // String table at 512.
  let strings = '\0'
  const add = (s: string) => {
    const at = strings.length
    strings += `${s}\0`
    return at
  }
  const needed = (opts.needed ?? ['libc.so.6', 'libstdc++.so.6']).map(add)
  const runpath = opts.runpath === undefined ? undefined : add(opts.runpath)
  buf.write(strings, 512)
  const dyn: Array<[number, number]> = [[5, base + 512], ...needed.map((n): [number, number] => [1, n])]
  if (runpath !== undefined) dyn.push([29, runpath])
  dyn.push([0, 0])
  dyn.forEach(([tag, value], i) => {
    buf.writeBigUInt64LE(BigInt(tag), 1024 + i * 16)
    buf.writeBigUInt64LE(BigInt(value), 1024 + i * 16 + 8)
  })
  const ph = (i: number, type: number, offset: number, size: number) => {
    const p = 64 + i * 56
    buf.writeUInt32LE(type, p)
    buf.writeBigUInt64LE(BigInt(offset), p + 8)
    buf.writeBigUInt64LE(BigInt(base + offset), p + 16)
    buf.writeBigUInt64LE(BigInt(size), p + 32)
  }
  ph(0, 1, 0, buf.length) // PT_LOAD
  ph(1, 3, 256, interpreter.length + 1) // PT_INTERP
  ph(2, 2, 1024, dyn.length * 16) // PT_DYNAMIC
  buf.writeUInt16LE(3, 0x38) // e_phnum
  return buf
}

export function macho64(opts: { dylibs?: string[]; rpaths?: string[] } = {}): Buffer {
  const cmds: Buffer[] = []
  const command = (cmd: number, headerSize: number, text: string) => {
    const size = Math.ceil((headerSize + Buffer.byteLength(text) + 1) / 8) * 8
    const c = Buffer.alloc(size)
    c.writeUInt32LE(cmd, 0)
    c.writeUInt32LE(size, 4)
    c.writeUInt32LE(headerSize, 8)
    c.write(text, headerSize)
    cmds.push(c)
  }
  command(0xe, 12, '/usr/lib/dyld')
  for (const d of opts.dylibs ?? ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib'])
    command(0xc, 24, d)
  for (const r of opts.rpaths ?? []) command(0x8000001c, 12, r)
  const body = Buffer.concat(cmds)
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  header.writeUInt32LE(2, 12)
  header.writeUInt32LE(cmds.length, 16)
  header.writeUInt32LE(body.length, 20)
  return Buffer.concat([header, body])
}

/** A universal (fat) binary holding the given slices. */
export function fat(slices: Buffer[]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(slices.length, 4)
  let offset = Math.ceil(header.length / 16) * 16
  const parts: Buffer[] = [header, Buffer.alloc(offset - header.length)]
  slices.forEach((s, i) => {
    header.writeUInt32BE(offset, 8 + i * 20 + 8)
    header.writeUInt32BE(s.length, 8 + i * 20 + 12)
    parts.push(s)
    offset += s.length
  })
  return Buffer.concat(parts)
}
