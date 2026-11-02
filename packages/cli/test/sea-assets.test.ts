import { describe, expect, it } from 'vitest'
import { embeddedPlugins, embeddedWebAssets, type SeaApi } from '../src/sea'

function fakeSea(files: Record<string, string> | null): SeaApi {
  return {
    isSea: () => files !== null,
    getAsset: ((key: string, encoding?: string) => {
      const v = files?.[key]
      if (v === undefined) throw new Error(`no asset ${key}`)
      return encoding ? v : new TextEncoder().encode(v).buffer
    }) as SeaApi['getAsset'],
  }
}

describe('the web app embedded in a standalone binary', () => {
  it('is absent when not running as a standalone binary', () => {
    expect(embeddedWebAssets(fakeSea(null))).toBeUndefined()
  })

  it('reads every file the manifest lists', () => {
    const assets = embeddedWebAssets(
      fakeSea({
        'web/manifest.json': JSON.stringify(['index.html', 'assets/a.js']),
        'web/index.html': '<!doctype html>',
        'web/assets/a.js': 'x',
      }),
    )!
    expect([...assets.keys()]).toEqual(['index.html', 'assets/a.js'])
    expect(new TextDecoder().decode(assets.get('assets/a.js'))).toBe('x')
  })

  it('refuses a malformed manifest', () => {
    expect(() => embeddedWebAssets(fakeSea({ 'web/manifest.json': '{"a":1}' }))).toThrow(/manifest/)
    expect(() => embeddedWebAssets(fakeSea({ 'web/manifest.json': '[1]' }))).toThrow(/manifest/)
  })
})

// 2026-11-01: the standalone binary carries its bundled plugins too (it carried none).
describe('the plugins embedded in a standalone binary', () => {
  it('are absent when not running as a standalone binary', () => {
    expect(embeddedPlugins(fakeSea(null))).toBeUndefined()
  })

  it('reads every file the manifest lists', () => {
    const plugins = embeddedPlugins(
      fakeSea({
        'plugins/manifest.json': JSON.stringify(['charts/mongo-manager-plugin.json', 'charts/index.html']),
        'plugins/charts/mongo-manager-plugin.json': '{"id":"charts"}',
        'plugins/charts/index.html': '<!doctype html>',
      }),
    )!
    expect([...plugins.keys()]).toEqual(['charts/mongo-manager-plugin.json', 'charts/index.html'])
    expect(new TextDecoder().decode(plugins.get('charts/index.html'))).toBe('<!doctype html>')
  })

  it('refuses a malformed manifest', () => {
    expect(() => embeddedPlugins(fakeSea({ 'plugins/manifest.json': '"x"' }))).toThrow(/manifest/)
  })
})
