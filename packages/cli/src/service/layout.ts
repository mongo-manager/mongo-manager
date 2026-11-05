// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { posix, win32 } from 'node:path'

export interface Layout {
  platform: NodeJS.Platform
  /** Root-owned copy of the program (dist/cli.cjs, public/). */
  programDir: string
  /** Everything that belongs to the service and survives uninstall. */
  stateRoot: string
  dataDir: string
  configFile: string
  /** Linux: root-only file holding MM_SECRET_KEY. Elsewhere the key file lives in dataDir. */
  envFile: string | null
  logFile: string | null
  /** The unit, plist or task name. */
  unit: string
  defaultUser: string
}

export function layoutFor(platform: NodeJS.Platform, env: Record<string, string | undefined>): Layout {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programData = env.ProgramData ?? 'C:\\ProgramData'
    const root = win32.join(programData, 'Mongo Manager')
    return {
      platform,
      programDir: win32.join(programFiles, 'Mongo Manager', 'app'),
      stateRoot: root,
      dataDir: win32.join(root, 'data'),
      configFile: win32.join(root, 'config.json'),
      envFile: null,
      logFile: win32.join(root, 'logs', 'mongo-manager.log'),
      unit: 'Mongo Manager',
      defaultUser: 'S-1-5-19',
    }
  }
  if (platform === 'darwin') {
    const root = '/Library/Application Support/Mongo Manager'
    return {
      platform,
      // Root-owned: on Intel Macs /usr/local belongs to the Homebrew user.
      programDir: posix.join(root, 'app'),
      stateRoot: root,
      dataDir: posix.join(root, 'data'),
      configFile: posix.join(root, 'config.json'),
      envFile: null,
      logFile: '/Library/Logs/Mongo Manager/mongo-manager.log',
      unit: '/Library/LaunchDaemons/com.mongo-manager.server.plist',
      defaultUser: '_mongomanager',
    }
  }
  return {
    platform,
    programDir: '/opt/mongo-manager/app',
    stateRoot: '/var/lib/mongo-manager',
    dataDir: '/var/lib/mongo-manager',
    configFile: '/etc/mongo-manager/config.json',
    envFile: '/etc/mongo-manager/env',
    logFile: null,
    unit: '/etc/systemd/system/mongo-manager.service',
    defaultUser: 'mongo-manager',
  }
}
