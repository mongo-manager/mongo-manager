// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import * as sea from 'node:sea'
import type { WebAssets } from '@mongo-manager/server'

export type SeaApi = Pick<typeof sea, 'isSea' | 'getAsset'>

/** True when running as the standalone single-executable binary. */
export const isStandalone = (api: SeaApi = sea): boolean => api.isSea()

/**
 * The web app embedded in the standalone binary (assets `web/<path>`, listed by
 * `web/manifest.json`), served from memory: nothing is written to disk. Undefined otherwise.
 */
export function embeddedWebAssets(api: SeaApi = sea): WebAssets | undefined {
  return embedded(api, 'web', 'The embedded web app manifest is malformed')
}

/**
 * 2026-11-01: the bundled plugins embedded in the standalone binary (assets `plugins/<path>`, listed
 * by `plugins/manifest.json`); the server writes them into the data directory. Undefined otherwise.
 */
export function embeddedPlugins(api: SeaApi = sea): Map<string, Uint8Array> | undefined {
  return embedded(api, 'plugins', 'The embedded plugins manifest is malformed')
}

function embedded(api: SeaApi, folder: string, malformed: string): Map<string, Uint8Array> | undefined {
  if (!api.isSea()) return undefined
  const manifest: unknown = JSON.parse(api.getAsset(`${folder}/manifest.json`, 'utf8'))
  if (!Array.isArray(manifest) || !manifest.every((p) => typeof p === 'string')) throw new Error(malformed)
  return new Map(manifest.map((p: string) => [p, new Uint8Array(api.getAsset(`${folder}/${p}`))]))
}
