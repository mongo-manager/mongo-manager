// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginManifestSchema } from '../src/api/plugins'

/**
 * Plugins wave 3: every plugin shipped with the app (a folder of packages/plugins with a manifest)
 * has a manifest the server takes, a README in English and in Turkish, and its package's version.
 */
const ROOT = join(__dirname, '..', '..', 'plugins')
const plugins = readdirSync(ROOT).filter((name) =>
  existsSync(join(ROOT, name, 'public', 'mongo-manager-plugin.json')),
)
/** Languages (2026-10-29): the languages the app offers (a messages file each), but English. */
const OFFERED = readdirSync(join(__dirname, '..', '..', 'web', 'src', 'i18n', 'locales'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((l) => l !== 'en')

describe('the first-party plugins', () => {
  it('are there', () => {
    expect(plugins).toEqual(
      expect.arrayContaining([
        'geojson-map',
        'local-time',
        'binary-preview',
        'mock-data',
        'data-dictionary',
        'reshape',
        'log-analyzer',
        'storage-report',
        'shard-key-analyzer',
        'search-playground',
        'anonymiser',
        'document-size',
        'personal-data',
        'ttl-view',
        'index-script',
        'date-presets',
        'legacy-uuid',
        'validation-inspector',
      ]),
    )
  })

  it.each(plugins)('%s has a valid manifest, a README in each language and one version', (name) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, name, 'public', 'mongo-manager-plugin.json'), 'utf8'))
    const parsed = PluginManifestSchema.safeParse(manifest)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(manifest.id).toBe(name)
    for (const readme of ['README.md', ...OFFERED.map((l) => `README.${l}.md`)])
      expect(existsSync(join(ROOT, name, 'public', readme)), readme).toBe(true)
    // Every localized text of the manifest, old release notes too, in every language offered.
    const texts = (v: unknown): Record<string, unknown>[] =>
      v && typeof v === 'object'
        ? 'en' in v && typeof (v as { en: unknown }).en === 'string'
          ? [v as Record<string, unknown>]
          : Object.values(v).flatMap(texts)
        : []
    for (const text of texts(manifest))
      expect(
        OFFERED.filter((l) => typeof text[l] !== 'string'),
        JSON.stringify(text.en),
      ).toEqual([])
    const pkg = JSON.parse(readFileSync(join(ROOT, name, 'package.json'), 'utf8'))
    expect(pkg.version).toBe(manifest.version)
    expect(manifest.changelog?.[0]?.version).toBe(manifest.version)
  })
})
