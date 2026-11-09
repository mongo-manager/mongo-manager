// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isAbsolute } from 'node:path'
import { windowsTool } from '@mongo-manager/server'

/**
 * The command that opens a URL, or a file (a launch redirect file), in the default browser: argument
 * array only, never a shell.
 */
export function browserCommand(target: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  const url = /^https?:\/\/[A-Za-z0-9.[\]:%_~/-]+$/.test(target)
  // Review of the audit fixes (important 2): a file of our own making, by its absolute path.
  const file = !url && isAbsolute(target) && !/[\r\n\0]/.test(target) && !target.startsWith('-')
  if (!url && !file) throw new Error('Refusing to open an unexpected URL')
  // By its place (review of the CI fixes): never a rundll32.exe in the folder this runs in, or found
  // earlier on the PATH.
  if (platform === 'win32')
    return { cmd: windowsTool('rundll32'), args: ['url.dll,FileProtocolHandler', target] }
  if (platform === 'darwin') return { cmd: 'open', args: [target] }
  return { cmd: 'xdg-open', args: [target] }
}
