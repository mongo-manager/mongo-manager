// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_MANIFEST } from '@mongo-manager/shared'

/** Whether a folder holds plugins: a sub-folder with a manifest (not, say, a source folder). */
const holdsPlugins = (dir: string) =>
  existsSync(dir) &&
  readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(join(dir, e.name, PLUGIN_MANIFEST)),
  )

/**
 * Phase 4b §4: the first of these folders that holds plugins. The program that starts the server
 * names where its bundled plugins are — the package's own `plugins/`, the monorepo build for tests —
 * and the server never guesses a folder (4b map review I1: a guess from a single executable's path
 * could reach a folder anyone may create).
 */
export const firstPluginFolder = (candidates: readonly string[]): string | undefined =>
  candidates.find(holdsPlugins)
