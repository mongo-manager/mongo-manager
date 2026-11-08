// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { posix } from 'node:path'
import type { Sys } from './sys'
import { trustProblems } from './trust'

/**
 * What the dynamic loader will load along with an executable. Copying only the executable is not
 * enough when it loads libraries from elsewhere: a Homebrew or Linuxbrew Node loads its libraries
 * from folders its owner (not root) can change, so they could be swapped to run code as the
 * service account (final review 1f-3, Critical 1). Parsed here from the file itself: no tool
 * (ldd would run the loader as root) and nothing executed.
 */
export interface Linked {
  format: 'elf' | 'macho'
  /** ELF PT_INTERP, Mach-O LC_LOAD_DYLINKER. */
  interpreter: string | null
  /** ELF DT_NEEDED, Mach-O LC_*_DYLIB install names. */
  needed: string[]
  /** ELF DT_RPATH/DT_RUNPATH (split on ':'), Mach-O LC_RPATH. */
  rpaths: string[]
}

const cstring = (buf: Buffer, at: number): string => {
  if (at < 0 || at >= buf.length) throw new Error('string outside the file')
  const end = buf.indexOf(0, at)
  return buf.toString('utf8', at, end < 0 ? buf.length : end)
}

function elf(buf: Buffer): Linked {
  const is64 = buf[4] === 2
  const le = buf[5] === 1
  if ((buf[4] !== 1 && buf[4] !== 2) || (buf[5] !== 1 && buf[5] !== 2)) throw new Error('bad ELF header')
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const word = (o: number) => (is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o))
  const phoff = word(is64 ? 0x20 : 0x1c)
  const phentsize = u16(is64 ? 0x36 : 0x2a)
  const phnum = u16(is64 ? 0x38 : 0x2c)
  const loads: Array<{ offset: number; vaddr: number; size: number }> = []
  let interpreter: string | null = null
  let dynamic: { offset: number; size: number } | null = null
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize
    const type = u32(p)
    const offset = word(is64 ? p + 8 : p + 4)
    const vaddr = word(is64 ? p + 16 : p + 8)
    const size = word(is64 ? p + 32 : p + 16)
    if (type === 1) loads.push({ offset, vaddr, size })
    if (type === 3) interpreter = cstring(buf, offset)
    if (type === 2) dynamic = { offset, size }
  }
  const needed: string[] = []
  const rpaths: string[] = []
  if (dynamic) {
    const entry = is64 ? 16 : 8
    const tags: Array<[number, number]> = []
    for (let o = dynamic.offset; o + entry <= dynamic.offset + dynamic.size; o += entry) {
      const tag = word(o)
      if (tag === 0) break
      tags.push([tag, word(o + entry / 2)])
    }
    const strtab = tags.find(([t]) => t === 5)?.[1]
    if (strtab !== undefined) {
      const seg = loads.find((l) => strtab >= l.vaddr && strtab < l.vaddr + l.size)
      if (!seg) throw new Error('string table outside the loaded segments')
      const base = seg.offset + (strtab - seg.vaddr)
      for (const [tag, value] of tags) {
        if (tag === 1) needed.push(cstring(buf, base + value))
        if (tag === 15 || tag === 29) rpaths.push(...cstring(buf, base + value).split(':'))
      }
    } else if (tags.some(([t]) => t === 1 || t === 15 || t === 29)) {
      throw new Error('dynamic section without a string table')
    }
  }
  return { format: 'elf', interpreter, needed, rpaths }
}

const DYLIB = new Set([0xc, 0x20, 0x80000018, 0x8000001f, 0x80000023])
const RPATH = 0x8000001c
const DYLINKER = 0xe

function machoSlice(buf: Buffer, start: number, into: Linked): void {
  const magic = buf.readUInt32LE(start)
  const le = magic === 0xfeedfacf || magic === 0xfeedface
  if (!le && buf.readUInt32BE(start) !== 0xfeedfacf && buf.readUInt32BE(start) !== 0xfeedface) {
    throw new Error('bad Mach-O header')
  }
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const is64 = u32(start) === 0xfeedfacf
  const ncmds = u32(start + 16)
  let o = start + (is64 ? 32 : 28)
  for (let i = 0; i < ncmds; i++) {
    const cmd = u32(o)
    const size = u32(o + 4)
    if (size < 8) throw new Error('bad load command')
    if (DYLIB.has(cmd)) into.needed.push(cstring(buf, o + u32(o + 8)))
    if (cmd === RPATH) into.rpaths.push(cstring(buf, o + u32(o + 8)))
    if (cmd === DYLINKER) into.interpreter = cstring(buf, o + u32(o + 8))
    o += size
  }
}

function macho(buf: Buffer): Linked {
  const out: Linked = { format: 'macho', interpreter: null, needed: [], rpaths: [] }
  const fat = buf.readUInt32BE(0)
  if (fat === 0xcafebabe || fat === 0xcafebabf) {
    // Universal binary: every architecture slice is checked.
    const n = buf.readUInt32BE(4)
    const entry = fat === 0xcafebabe ? 20 : 32
    for (let i = 0; i < n; i++) {
      const e = 8 + i * entry
      const offset = fat === 0xcafebabe ? buf.readUInt32BE(e + 8) : Number(buf.readBigUInt64BE(e + 8))
      machoSlice(buf, offset, out)
    }
  } else {
    machoSlice(buf, 0, out)
  }
  return out
}

/** Parses an ELF or Mach-O executable; anything else is refused (fail closed). */
export function linkedLibraries(buf: Buffer): Linked {
  try {
    if (buf.length >= 52 && buf.readUInt32BE(0) === 0x7f454c46) return elf(buf)
    if (buf.length >= 32) {
      const be = buf.readUInt32BE(0)
      const le = buf.readUInt32LE(0)
      if (
        [0xcafebabe, 0xcafebabf, 0xfeedfacf, 0xfeedface].includes(be) ||
        [0xfeedfacf, 0xfeedface].includes(le)
      ) {
        return macho(buf)
      }
    }
  } catch (e) {
    throw new Error(`its libraries could not be read (${(e as Error).message})`, { cause: e })
  }
  throw new Error('it is not an ELF or Mach-O executable')
}

/** macOS system libraries live in the sealed system volume (or the shared cache) and are SIP-protected. */
const MAC_SYSTEM = ['/usr/lib/', '/System/Library/']

/**
 * The paths whose owners decide what the executable at `exe` loads: interpreter, library search
 * paths and libraries named by path. Throws on search paths that cannot be judged.
 */
export function loadPaths(linked: Linked, exe: string): string[] {
  const dir = posix.dirname(exe)
  const paths: string[] = []
  if (linked.format === 'elf') {
    if (linked.interpreter !== null) paths.push(linked.interpreter)
    for (const r of linked.rpaths) {
      const expanded = r.replace(/\$(\{ORIGIN\}|ORIGIN\b)/g, dir)
      if (!expanded.startsWith('/') || expanded.includes('$')) {
        throw new Error(`it searches libraries in ${JSON.stringify(r)}, which cannot be checked`)
      }
      paths.push(expanded)
    }
    for (const n of linked.needed) {
      if (!n.includes('/')) continue // Found through the search paths above and the system's own folders.
      if (!n.startsWith('/')) throw new Error(`it loads ${n} relative to the working directory`)
      paths.push(n)
    }
  } else {
    const at = (p: string) => p.replace(/^@(executable_path|loader_path)(?=\/|$)/, dir)
    const rpaths = linked.rpaths.map(at)
    for (const r of rpaths) {
      if (!r.startsWith('/'))
        throw new Error(`it searches libraries in ${JSON.stringify(r)}, which cannot be checked`)
      paths.push(r)
    }
    for (const n of [...(linked.interpreter ? [linked.interpreter] : []), ...linked.needed]) {
      if (n.startsWith('@rpath/')) continue // Resolved inside the search paths checked above.
      const p = at(n)
      if (!p.startsWith('/')) throw new Error(`it loads ${n}, which cannot be checked`)
      paths.push(p)
    }
  }
  return [...new Set(paths)].filter(
    (p) => !(linked.format === 'macho' && MAC_SYSTEM.some((s) => p.startsWith(s))),
  )
}

/**
 * Refuses an executable that loads code from anywhere a non-administrator can change (POSIX).
 * A path that does not exist is judged by its nearest existing folder: whoever can create it
 * could plant a library there.
 */
export function checkLinked(sys: Sys, exe: string, what: string, hint: string): void {
  if (sys.platform === 'win32') return
  let paths: string[]
  try {
    paths = loadPaths(linkedLibraries(sys.readBytes(exe)), exe)
  } catch (e) {
    throw new Error(`${what} ${exe} cannot run as a service: ${(e as Error).message}.\n${hint}`, { cause: e })
  }
  for (const path of paths) {
    let p = path
    while (sys.stat(p) === null && posix.dirname(p) !== p) p = posix.dirname(p)
    let real: string
    try {
      real = sys.realpath(p)
    } catch {
      real = p
    }
    const problems = trustProblems(sys, real)
    if (problems.length > 0) {
      throw new Error(
        `${what} ${exe} loads code from ${path}, which users other than administrators can change ` +
          `(for example a Homebrew or Linuxbrew install), so it must not run as a service:\n  ` +
          `${problems.slice(0, 6).join('\n  ')}\n${hint}`,
      )
    }
  }
}
