import { ARCHIVE_MAGIC } from './archive-writer'
import { MMBAK_MAGIC } from './mmbak'

export type Container = 'archive' | 'gzip' | 'mmbak' | 'zip'

/** Spec §3.2: the format comes from the first bytes, never from the file's name. */
export function detectContainer(head: Buffer): Container | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(MMBAK_MAGIC)) return 'mmbak'
  if (head.length >= 4 && head.readUInt32LE(0) === ARCHIVE_MAGIC) return 'archive'
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip'
  return null
}
