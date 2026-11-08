// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createRequire } from 'node:module'

/**
 * The MongoDB this run starts (MONGOMS_VERSION, else the memory server's default), known before
 * any server is: for runIf and skipIf. Review of 69adc29a (M-4): never a version written here.
 */
export function runVersion(): string {
  if (process.env.MONGOMS_VERSION) return process.env.MONGOMS_VERSION
  const fromHere = createRequire(import.meta.url)
  const core = createRequire(fromHere.resolve('mongodb-memory-server'))
  return String(core('mongodb-memory-server-core/lib/util/resolveConfig').DEFAULT_VERSION)
}

/** Whether a version is major.minor or later. */
export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [x, y] = version.split('.').map(Number) as [number, number]
  return x > major || (x === major && y >= minor)
}
