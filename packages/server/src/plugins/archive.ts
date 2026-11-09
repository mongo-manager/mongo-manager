// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  PLUGIN_MANIFEST,
  TarError,
  type TarEntry,
  PLUGIN_MAX_BYTES,
  PLUGIN_MAX_FILES,
  PluginPathSchema,
  isSpoofingChar,
  readTar,
} from '@mongo-manager/shared'
import { Errors } from '../errors'

/** A file of a plugin archive. */
export interface ArchiveEntry {
  path: string
  data: Buffer
}

const refuse = (message: string) => Errors.validation(message)

/**
 * Phase 4b §2: a plugin's `.tgz`, read in memory with every limit checked as it goes — files only
 * (folders implied), at most PLUGIN_MAX_FILES of them and PLUGIN_MAX_BYTES in all, each path plain
 * and inside the plugin. Links, devices and other special entries, a path given twice (in any case)
 * and a damaged archive are refused. One top folder (npm pack's `package/`) is taken off.
 */
export function readPluginArchive(archive: Buffer): ArchiveEntry[] {
  let entries: TarEntry[]
  try {
    // The tar reader is the updater's too (2026-11-03); the plugin's own path rules follow.
    entries = readTar(archive, { maxBytes: PLUGIN_MAX_BYTES, maxFiles: PLUGIN_MAX_FILES + 1, paths: 'raw' })
  } catch (e) {
    if (!(e instanceof TarError)) throw e
    switch (e.code) {
      case 'too_large':
        throw refuse(`A plugin holds at most ${PLUGIN_MAX_BYTES / 1024 / 1024} MB`)
      case 'too_many':
        throw refuse(`A plugin holds at most ${PLUGIN_MAX_FILES} files`)
      case 'special':
        throw refuse('Links, devices and special files are refused in a plugin')
      default:
        throw refuse(e.message)
    }
  }
  return checkedEntries(entries.map(({ path, data }) => ({ path, data })))
}

/** Paths made relative to the plugin, each checked; one top folder taken off when the manifest is in it. */
export function checkedEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  let list = entries
  if (!list.some((e) => e.path === PLUGIN_MANIFEST)) {
    const top = list[0]?.path.split('/')[0]
    if (
      top &&
      list.every((e) => e.path.startsWith(`${top}/`)) &&
      list.some((e) => e.path === `${top}/${PLUGIN_MANIFEST}`)
    )
      list = list.map((e) => ({ ...e, path: e.path.slice(top.length + 1) }))
    else throw refuse(`A plugin has ${PLUGIN_MANIFEST} at its top`)
  }
  if (list.length > PLUGIN_MAX_FILES) throw refuse(`A plugin holds at most ${PLUGIN_MAX_FILES} files`)
  const seen = new Set<string>()
  const folders = new Set<string>()
  for (const e of list) {
    if (!PluginPathSchema.safeParse(e.path).success)
      throw refuse(`Not a plain path in a plugin: ${shown(e.path)}`)
    const key = e.path.toLowerCase()
    if (seen.has(key) || folders.has(key)) throw refuse(`A path is given twice: ${shown(e.path)}`)
    seen.add(key)
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      if (seen.has(folder)) throw refuse(`A path is given twice, as a file and a folder: ${shown(folder)}`)
      folders.add(folder)
    }
  }
  return list
}

const shown = (p: string) => safeName(p.length > 120 ? `${p.slice(0, 120)}…` : p)

/** A name from an archive or a folder as a message shows it: quoted, what fakes its form as \uXXXX. */
export const safeName = (p: string) =>
  JSON.stringify(p).replace(/[^\x20-\x7e]/gu, (c) =>
    isSpoofingChar(c.codePointAt(0)!) ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c,
  )
