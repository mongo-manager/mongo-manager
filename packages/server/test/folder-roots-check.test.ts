// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderRootWarnings } from '../src/backup/roots-check'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

/**
 * Third review 2026-10-17 (important): the systemd unit lets the server write into its data
 * directory alone (ProtectSystem=strict), so every folder backup failed there, read-only, while
 * doctor, outside that sandbox, found the root writable. Only the server sees what it may write
 * into: it says so at each start.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-roots-'))
  dirs.push(d)
  return d
}
const failing = (code: string) => ({
  statSync: () => ({ isDirectory: () => true }),
  accessSync: () => {
    throw Object.assign(new Error(code), { code })
  },
})

describe('the folder roots, as the server can write into them', () => {
  it('says nothing of a directory it can write into', () => {
    expect(folderRootWarnings([temp()])).toEqual([])
  })

  it('names a root that does not exist, and one that is a file', () => {
    const dir = temp()
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    expect(folderRootWarnings([join(dir, 'missing'), file], { platform: 'darwin' })).toEqual([
      `Backup folder root ${join(dir, 'missing')} does not exist: create it. Folder destinations under it fail.`,
      `Backup folder root ${file} is not a directory. Folder destinations under it fail.`,
    ])
  })

  // Fourth review 2026-10-17 (minor 6), final review (minor 4): on Linux, what the service meets.
  it('says on Linux that the service sees a root made after its start only from its next one', () => {
    expect(folderRootWarnings(['/srv/backups'], { fs: failing('ENOENT'), platform: 'linux' })).toEqual([
      'Backup folder root /srv/backups does not exist for this server: create it, then restart Mongo ' +
        'Manager (the systemd service sees a folder made after its start only from its next one, and none ' +
        'under /tmp or /var/tmp, which it has its own of). Folder destinations under it fail.',
    ])
  })

  it('names the service sandbox when the root is read-only to it, on Linux', () => {
    expect(folderRootWarnings(['/srv/backups'], { fs: failing('EROFS'), platform: 'linux' })).toEqual([
      'Backup folder root /srv/backups is read-only to this server: a read-only file system, or the ' +
        "sandbox of the systemd service, which lets it write only where it is told (run 'mongo-manager " +
        "service install' again with sudo: it adds the folder roots it may, and says why of each it " +
        'leaves out). Folder destinations under it fail.',
    ])
    expect(folderRootWarnings(['/srv/backups'], { fs: failing('EROFS'), platform: 'darwin' })).toEqual([
      'Backup folder root /srv/backups is on a read-only file system. Folder destinations under it fail.',
    ])
  })

  it('names the error when the root forbids this server to write', () => {
    expect(folderRootWarnings(['/srv/backups'], { fs: failing('EACCES') })).toEqual([
      'Backup folder root /srv/backups is not writable by this server (EACCES). Folder destinations ' +
        'under it fail.',
    ])
  })

  it('is said at start', async () => {
    const dir = temp()
    const logFile = join(dir, 'mm.log')
    const missing = join(dir, 'missing')
    const s = await startServer(
      resolveConfig({
        cli: { dataDir: join(dir, 'data'), webPort: 0, logLevel: 'info', logFile },
        env: { MM_BACKUP_FOLDER_ROOTS: missing },
      }),
      { logger: true },
    )
    await s.close()
    expect(readFileSync(logFile, 'utf8')).toContain(
      `Backup folder root ${JSON.stringify(missing).slice(1, -1)}`,
    )
  })

  it('says nothing at start of a root it can write into', async () => {
    const dir = temp()
    const logFile = join(dir, 'mm.log')
    const root = join(dir, 'exports')
    mkdirSync(root)
    const s = await startServer(
      resolveConfig({
        cli: { dataDir: join(dir, 'data'), webPort: 0, logLevel: 'info', logFile },
        env: { MM_BACKUP_FOLDER_ROOTS: root },
      }),
      { logger: true },
    )
    await s.close()
    expect(readFileSync(logFile, 'utf8')).not.toContain('Backup folder root')
  })
})
