// Windows PE files: the standalone binary starts as a copy of the signed node.exe. Injecting the
// app invalidates that signature, and a broken signature looks worse to antivirus products than
// none, so it is removed first (what `signtool remove /s` does), without needing the Windows SDK.

/** The optional header of a PE file, or null for anything else. */
function optionalHeader(buf) {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') return null
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) return null
  // Data directories follow the fixed fields: 96 bytes in PE32, 112 in PE32+.
  return {
    opt,
    dirs: opt + (magic === 0x20b ? 112 : 96),
    count: buf.readUInt32LE(opt + (magic === 0x20b ? 108 : 92)),
  }
}

/** The certificate table (data directory 4): a file offset and size; zeros when unsigned. */
export function securityDirectory(buf) {
  const h = optionalHeader(buf)
  if (!h || h.count < 5) return { offset: 0, size: 0 }
  return { offset: buf.readUInt32LE(h.dirs + 32), size: buf.readUInt32LE(h.dirs + 36) }
}

/** The file without its Authenticode signature; the same buffer when there is none. */
export function stripAuthenticode(buf) {
  const h = optionalHeader(buf)
  const { offset, size } = securityDirectory(buf)
  if (!h || size === 0) return buf
  // Signing appends the table (padded to 8 bytes); anything else is not a file we understand.
  if (offset + size !== buf.length && Math.ceil((offset + size) / 8) * 8 !== buf.length) {
    throw new Error('the certificate table is not at the end of the file')
  }
  const out = Buffer.from(buf.subarray(0, offset))
  out.writeUInt32LE(0, h.dirs + 32)
  out.writeUInt32LE(0, h.dirs + 36)
  out.writeUInt32LE(0, h.opt + 64) // CheckSum: optional for anything but drivers.
  return out
}
