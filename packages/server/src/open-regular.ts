// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { constants, lstatSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/** The errors of a path that leads to no openable regular file. */
const NOT_THERE = new Set(['ENOENT', 'EISDIR', 'ELOOP', 'EPERM', 'ENOTDIR', 'EACCES'])

/**
 * CodeQL 2026-11-01 (file-system-race), as the folder destination opens its objects (Phase 3d-3b
 * final review, A19): opened first, then checked — the open file must be a regular file and the path
 * must still lead to that very file (device and inode), with no link at its name. Checking first and
 * opening after left a window to swap in a link to any file the server can read. Null when there is
 * no such file; the caller says "not found".
 */
export async function openRegularFile(path: string): Promise<FileHandle | null> {
  let handle: FileHandle
  try {
    // O_NOFOLLOW where the platform has it: a link at the file's own name is not followed.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (e) {
    if (NOT_THERE.has((e as NodeJS.ErrnoException).code ?? '')) return null
    throw e
  }
  try {
    const opened = await handle.stat()
    let now: ReturnType<typeof lstatSync> | undefined
    try {
      now = lstatSync(path)
    } catch {
      now = undefined
    }
    if (
      opened.isFile() &&
      now &&
      !now.isSymbolicLink() &&
      now.isFile() &&
      now.ino === opened.ino &&
      now.dev === opened.dev
    )
      return handle
  } catch (e) {
    await handle.close()
    throw e
  }
  await handle.close()
  return null
}
