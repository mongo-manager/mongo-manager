// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { gzipSync } from 'node:zlib'

/** One entry of a test archive: a file by default; any type flag, header field or raw size. */
export interface TarSpec {
  name: string
  data?: Buffer | string
  /** '0' file, '5' folder, '1' hard link, '2' symlink, '3' device, 'x' pax, 'L' GNU long name… */
  type?: string
  linkname?: string
  prefix?: string
  /** The header's mode; 0o644 when left out. */
  mode?: number
  /** Written in the header in place of the data's size. */
  size?: number
  /** Spoils the header's checksum. */
  badChecksum?: boolean
}

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0'

function header(spec: TarSpec, size: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(spec.name, 0, 100, 'utf8')
  h.write(octal(spec.mode ?? 0o644, 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(spec.size ?? size, 12), 124, 'ascii')
  h.write(octal(0, 12), 136, 'ascii')
  h.write(spec.type ?? '0', 156, 'ascii')
  if (spec.linkname) h.write(spec.linkname, 157, 100, 'utf8')
  h.write('ustar\u000000', 257, 'ascii')
  if (spec.prefix) h.write(spec.prefix, 345, 155, 'utf8')
  h.fill(' ', 148, 156)
  let sum = 0
  for (const b of h) sum += b
  h.write(octal(spec.badChecksum ? sum + 1 : sum, 7) + ' ', 148, 'ascii')
  return h
}

/** A pax record set ("len key=value\n" each). */
export function pax(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      const body = ` ${k}=${v}\n`
      let len = body.length + 1
      while (`${len}${body}`.length !== len) len = `${len}${body}`.length
      return `${len}${body}`
    })
    .join('')
}

/** A tar archive of the given entries. */
export function tar(specs: TarSpec[]): Buffer {
  const parts: Buffer[] = []
  for (const spec of specs) {
    const data = Buffer.from(spec.data ?? '')
    parts.push(header(spec, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export const tgz = (specs: TarSpec[]) => gzipSync(tar(specs))
