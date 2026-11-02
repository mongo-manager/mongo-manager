import { createHash } from 'node:crypto'
import { scanPlugin } from './scan'

/**
 * The scan, or null when it fails (review 2026-10-11): a scanner bug breaks no plugin, and an
 * unscanned plugin is approved only as one with a high finding is.
 */
function scanned(...args: Parameters<typeof scanPlugin>): PluginScan | null {
  try {
    return scanPlugin(...args)
  } catch {
    return null
  }
}
import { safeName } from './archive'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PluginScan,
  PLUGIN_MANIFEST,
  PLUGIN_MAX_BYTES,
  PLUGIN_MAX_FILES,
  PluginManifestSchema,
  PluginPathSchema,
  type PluginManifest,
} from '@mongo-manager/shared'

/** What a plugin folder holds: its files' SHA-256, their digest, and its manifest or why not. */
export interface PluginFiles {
  manifest: PluginManifest | null
  error: string | null
  /** The SHA-256 of every file, by path: what an approval is for. Null when the files cannot be read. */
  digest: string | null
  files: Record<string, string>
  bytes: number
  /** What its files were found to try (user request 2026-10-11); null when they cannot be read. */
  scan: PluginScan | null
}

const MANIFEST_BYTES = 64 * 1024
/** The files the scan reads: script, markup and style. */
const SCANNED = /\.(?:m?js|cjs|html?|svg|css)$/i

/** The SHA-256 of a set of files: each path with its own hash, in order. */
export function digestOf(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}\u0000${files[p]}\n`)
  return createHash('sha256').update(lines.join('')).digest('hex')
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** A manifest checked against its plugin: valid, named as its folder, its entry among its files. */
export function checkManifest(
  text: Buffer | undefined,
  id: string,
  paths: ReadonlySet<string>,
): PluginManifest {
  if (!text) throw new Error(`No ${PLUGIN_MANIFEST}`)
  if (text.length > MANIFEST_BYTES) throw new Error(`${PLUGIN_MANIFEST} is over 64 KB`)
  let json: unknown
  try {
    json = JSON.parse(text.toString('utf8'))
  } catch {
    throw new Error(`${PLUGIN_MANIFEST} is not valid JSON`)
  }
  const parsed = PluginManifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new Error(`The manifest is not valid: ${issue.path.join('.') || 'manifest'} — ${issue.message}`)
  }
  if (parsed.data.id !== id)
    throw new Error(`The manifest's id "${parsed.data.id}" is not its folder's name "${id}"`)
  if (!paths.has(parsed.data.entry)) throw new Error(`The entry ${parsed.data.entry} is not among its files`)
  return parsed.data
}

/**
 * Phase 4b §2: a plugin folder read without following anything — a link, a junction or any special
 * file makes it unusable, as do a path that is not plain (hidden files too) and the limits.
 */
export async function readPluginFolder(dir: string, id: string): Promise<PluginFiles> {
  // Kept by path in a map of its own (no inherited names), as the archive's paths are checked.
  const files: Record<string, string> = Object.create(null) as Record<string, string>
  const contents = new Map<string, Buffer>()
  let bytes = 0
  const fail = (error: string): PluginFiles => ({
    manifest: null,
    error,
    digest: null,
    files: {},
    bytes: 0,
    scan: null,
  })
  try {
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(dir, ...rel.split('/').filter(Boolean)), {
        withFileTypes: true,
      })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        const stat = await lstat(join(dir, ...path.split('/')))
        if (stat.isSymbolicLink() || entry.isSymbolicLink())
          throw new Error(`A plugin may not hold links: ${safeName(path)}`)
        if (stat.isDirectory()) {
          if (!PluginPathSchema.safeParse(path).success)
            throw new Error(`Not a plain path: ${safeName(path)}`)
          await walk(path)
          continue
        }
        if (!stat.isFile()) throw new Error(`A plugin may hold only files and folders: ${safeName(path)}`)
        if (!PluginPathSchema.safeParse(path).success) throw new Error(`Not a plain path: ${safeName(path)}`)
        if (Object.keys(files).length >= PLUGIN_MAX_FILES)
          throw new Error(`A plugin holds at most ${PLUGIN_MAX_FILES} files`)
        bytes += stat.size
        if (bytes > PLUGIN_MAX_BYTES)
          throw new Error(`A plugin holds at most ${PLUGIN_MAX_BYTES / 1024 / 1024} MB`)
        const data = await readFile(join(dir, ...path.split('/')))
        files[path] = sha256(data)
        if (path === PLUGIN_MANIFEST || SCANNED.test(path)) contents.set(path, data)
      }
    }
    await walk('')
  } catch (e) {
    return fail((e as Error).message)
  }
  const digest = digestOf(files)
  try {
    const manifest = checkManifest(contents.get(PLUGIN_MANIFEST), id, new Set(Object.keys(files)))
    return { manifest, error: null, digest, files, bytes, scan: scanned(contents, manifest) }
  } catch (e) {
    return { manifest: null, error: (e as Error).message, digest, files, bytes, scan: null }
  }
}
