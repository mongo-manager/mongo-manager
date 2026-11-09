// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { accessSync, constants, statSync } from 'node:fs'

interface RootFs {
  statSync: (path: string) => { isDirectory(): boolean }
  accessSync: (path: string, mode: number) => void
}

const FAILS = 'Folder destinations under it fail.'

/**
 * Third review 2026-10-17 (important): each folder root this server cannot write into, as it runs.
 * Only the server sees that: the systemd unit lets it write where it is told alone
 * (ProtectSystem=strict), so a root anyone else finds writable is read-only to it. What the Linux
 * service meets is said on Linux alone (final review, minor 4).
 */
export function folderRootWarnings(
  roots: string[],
  opts: { fs?: RootFs; platform?: NodeJS.Platform } = {},
): string[] {
  const fs = opts.fs ?? { statSync, accessSync }
  const linux = (opts.platform ?? process.platform) === 'linux'
  const warnings: string[] = []
  for (const root of roots) {
    try {
      if (!fs.statSync(root).isDirectory()) {
        warnings.push(`Backup folder root ${root} is not a directory. ${FAILS}`)
        continue
      }
      fs.accessSync(root, constants.W_OK)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT')
        // Fourth review 2026-10-17 (minor 6): systemd leaves a missing one out until the next start,
        // and the service has its own /tmp and /var/tmp, where one made outside it is not.
        warnings.push(
          linux
            ? `Backup folder root ${root} does not exist for this server: create it, then restart Mongo ` +
                'Manager (the systemd service sees a folder made after its start only from its next one, ' +
                `and none under /tmp or /var/tmp, which it has its own of). ${FAILS}`
            : `Backup folder root ${root} does not exist: create it. ${FAILS}`,
        )
      else if (code === 'EROFS')
        warnings.push(
          linux
            ? `Backup folder root ${root} is read-only to this server: a read-only file system, or the ` +
                'sandbox of the systemd service, which lets it write only where it is told (run ' +
                "'mongo-manager service install' again with sudo: it adds the folder roots it may, and says " +
                `why of each it leaves out). ${FAILS}`
            : `Backup folder root ${root} is on a read-only file system. ${FAILS}`,
        )
      else warnings.push(`Backup folder root ${root} is not writable by this server (${code}). ${FAILS}`)
    }
  }
  return warnings
}
