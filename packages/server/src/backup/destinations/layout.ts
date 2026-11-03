import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { BACKUP_FORMATS, type BackupFormat } from '@mongo-manager/shared'
import { DestinationError } from './types'

/**
 * Phase 3d-3b spec §1.3: <prefix>/mongo-manager/<yyyy>/<mm>/mm-<yyyymmdd-hhmmss>-<id8>.<ext> and its
 * <same>.json manifest. Neither holds a database or collection name, whatever the format.
 */
export const EXT: Record<BackupFormat, string> = { mmbak: 'mmbak', archive: 'archive', gzip: 'archive.gz' }
const TAIL = /^mongo-manager\/\d{4}\/\d{2}\/mm-\d{8}-\d{6}-[0-9a-f]{8}\.(mmbak|archive|archive\.gz)$/
const SEGMENT = /^[A-Za-z0-9._ -]{1,128}$/
export const MANIFEST_LIMIT = 64 * 1024

export const layoutRoot = (prefix: string) => (prefix ? `${prefix}/mongo-manager` : 'mongo-manager')

export function remoteKeyFor(prefix: string, format: BackupFormat, backupId: string, at: number): string {
  const d = new Date(at).toISOString()
  const stamp = `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}`
  return `${layoutRoot(prefix)}/${d.slice(0, 4)}/${d.slice(5, 7)}/mm-${stamp}-${backupId.slice(0, 8)}.${EXT[format]}`
}

/** The path's segments, refusing empty, "." and ".." segments and anything but safe characters. */
export function assertSafePath(key: string): string[] {
  const parts = key.split('/')
  if (!parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..' && p.trim() === p))
    throw new DestinationError('path', 'The remote path is not one Mongo Manager writes')
  return parts
}

/** D11, D14: a key from a listing, a manifest or a request is used only when it is our layout. */
export function isSafeKey(key: string, prefix: string): boolean {
  const root = prefix ? `${prefix}/` : ''
  if (!key.startsWith(root) || !TAIL.test(key.slice(root.length))) return false
  try {
    assertSafePath(key)
    return true
  } catch {
    return false
  }
}

export function formatOfKey(key: string): BackupFormat | null {
  if (key.endsWith('.archive.gz')) return 'gzip'
  if (key.endsWith('.archive')) return 'archive'
  if (key.endsWith('.mmbak')) return 'mmbak'
  return null
}
export const nameOfKey = (key: string) => key.slice(key.lastIndexOf('/') + 1)
export const manifestKeyOf = (key: string) => `${key}.json`
export const probeKey = (prefix: string) => `${layoutRoot(prefix)}/.probe-${randomBytes(8).toString('hex')}`

export const ManifestSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().uuid(),
  format: z.enum(BACKUP_FORMATS),
  size: z
    .number()
    .int()
    .min(0)
    .max(2 ** 50),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().min(0),
  tool: z.strictObject({ name: z.string().max(64), version: z.string().max(32) }),
})
export type Manifest = z.infer<typeof ManifestSchema>

export function buildManifest(m: Omit<Manifest, 'v'>): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, ...m }))
}

/** D14: untrusted — bounded, parsed, schema-checked; anything else is "no manifest". */
export function parseManifest(buf: Buffer | null): Manifest | null {
  if (!buf || buf.length > MANIFEST_LIMIT) return null
  try {
    const r = ManifestSchema.safeParse(JSON.parse(buf.toString('utf8')))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export const encodeCursor = (s: string | null) =>
  s === null ? null : Buffer.from(s, 'utf8').toString('base64url')
export const decodeCursor = (s: string | undefined | null) =>
  s ? Buffer.from(s, 'base64url').toString('utf8').slice(0, 4096) : null
