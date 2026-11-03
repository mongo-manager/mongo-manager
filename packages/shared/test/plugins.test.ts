import { describe, expect, it } from 'vitest'
import {
  PluginManifestSchema,
  PluginPathSchema,
  PluginSettingsValuesSchema,
  cspImageSource,
  isHiddenChar,
  isHiddenAt,
  isInvisibleChar,
  pluginSettingsSchema,
} from '../src/browser'

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'geojson-map',
  name: { en: 'Map', tr: 'Harita' },
  version: '1.0.0',
  description: { en: 'Draws GeoJSON fields on a map.' },
  entry: 'index.html',
  permissions: ['documents:read'],
  contributes: {
    collectionTabs: [{ id: 'map', title: { en: 'Map', tr: 'Harita' }, icon: 'map' }],
    documentActions: [{ id: 'show', title: { en: 'Show on map' } }],
    sidebarPanels: [],
    cellRenderers: [{ id: 'point', match: 'geojson' }],
  },
  settings: { tileUrl: { type: 'url', title: { en: 'Tile server' } } },
  ...over,
})

describe('plugin manifest (phase 4b §2)', () => {
  it('takes a good manifest', () => {
    const parsed = PluginManifestSchema.parse(manifest())
    expect(parsed.contributes.collectionTabs[0]!.icon).toBe('map')
    // Missing contribution kinds are empty lists.
    expect(PluginManifestSchema.parse(manifest({ contributes: {} })).contributes.sidebarPanels).toEqual([])
  })

  it('refuses ids, versions and fields it does not know', () => {
    for (const id of ['Map', 'a_b', '-a', 'a-', 'a--b', '', 'x'.repeat(65), '../x'])
      expect(PluginManifestSchema.safeParse(manifest({ id })).success, id).toBe(false)
    for (const version of ['1', '1.0', 'v1.0.0', '1.0.0-', '01.0.0', '1.0.0+'.padEnd(80, 'x')])
      expect(PluginManifestSchema.safeParse(manifest({ version })).success, version).toBe(false)
    expect(PluginManifestSchema.safeParse(manifest({ version: '2.1.3-beta.1' })).success).toBe(true)
    expect(PluginManifestSchema.safeParse(manifest({ main: 'server.js' })).success).toBe(false)
    expect(PluginManifestSchema.safeParse(manifest({ permissions: ['settings:manage'] })).success).toBe(false)
    expect(
      PluginManifestSchema.safeParse(manifest({ permissions: ['documents:read', 'documents:read'] })).success,
    ).toBe(false)
  })

  it('refuses an entry or a path that escapes the plugin folder', () => {
    for (const entry of [
      '../index.html',
      '/index.html',
      'a/../../b.html',
      'C:/x.html',
      'a\\b.html',
      './x.html',
      'a//b.html',
      'x.html\u0000',
      'con.html',
      'a/aux.js',
      '.hidden/x.html',
      'index.js',
    ])
      expect(PluginManifestSchema.safeParse(manifest({ entry })).success, entry).toBe(false)
    for (const path of ['__proto__', 'a/constructor', 'prototype/x.js'])
      expect(PluginPathSchema.safeParse(path).success, path).toBe(false)
    for (const path of ['assets/app-1a2b.js', 'index.html', 'img/marker.png'])
      expect(PluginPathSchema.safeParse(path).success, path).toBe(true)
    expect(PluginPathSchema.safeParse('a/'.repeat(17) + 'x.js').success).toBe(false)
  })

  it('lets a cell renderer ask about ObjectIds (wave 1)', () => {
    expect(
      PluginManifestSchema.safeParse(
        manifest({ contributes: { cellRenderers: [{ id: 'made', match: 'objectId' }] } }),
      ).success,
    ).toBe(true)
  })

  it('lets a cell renderer show beside the value or in a tooltip, beside by default (2026-10-13)', () => {
    const parse = (r: Record<string, unknown>) =>
      PluginManifestSchema.safeParse(
        manifest({ contributes: { cellRenderers: [{ id: 'made', match: 'objectId', ...r }] } }),
      )
    expect(parse({}).data?.contributes.cellRenderers[0]!.display).toBe('inline')
    expect(parse({ display: 'tooltip' }).data?.contributes.cellRenderers[0]!.display).toBe('tooltip')
    expect(parse({ display: 'popup' }).success).toBe(false)
  })

  it('bounds what a plugin contributes, and checks names, icons and matches', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: { en: 'T' } }))
    expect(PluginManifestSchema.safeParse(manifest({ contributes: { collectionTabs: many } })).success).toBe(
      false,
    )
    expect(
      PluginManifestSchema.safeParse(
        manifest({ contributes: { collectionTabs: [{ id: 'a', title: { en: 'A' }, icon: 'skull' }] } }),
      ).success,
    ).toBe(false)
    expect(
      PluginManifestSchema.safeParse(
        manifest({ contributes: { cellRenderers: [{ id: 'a', match: 'everything' }] } }),
      ).success,
    ).toBe(false)
    expect(
      PluginManifestSchema.safeParse(
        manifest({
          contributes: {
            documentActions: [
              { id: 'a', title: { en: 'A' } },
              { id: 'a', title: { en: 'B' } },
            ],
          },
        }),
      ).success,
    ).toBe(false)
    expect(PluginManifestSchema.safeParse(manifest({ name: { en: 'x'.repeat(61) } })).success).toBe(false)
    expect(PluginManifestSchema.safeParse(manifest({ name: { en: 'a\u202Eb' } })).success).toBe(false)
  })

  it('checks setting values against what the manifest declares', () => {
    const declared = PluginManifestSchema.parse(
      manifest({
        settings: {
          tileUrl: { type: 'url', title: { en: 'Tiles' } },
          label: { type: 'text', title: { en: 'Label' } },
          grid: { type: 'boolean', title: { en: 'Grid' } },
        },
      }),
    ).settings
    const values = pluginSettingsSchema(declared)
    expect(
      values.safeParse({ tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png', grid: true }).success,
    ).toBe(true)
    for (const tileUrl of [
      'javascript:alert(1)',
      'https://user:pw@tiles.example.org/{z}.png',
      "https://tiles.example.org/x.png'; script-src *",
      'https://tiles example.org/{z}.png',
      'ftp://tiles.example.org/{z}.png',
    ])
      expect(values.safeParse({ tileUrl }).success, tileUrl).toBe(false)
    expect(values.safeParse({ unknown: 1 }).success).toBe(false)
    expect(values.safeParse({ grid: 'yes' }).success).toBe(false)
    expect(PluginSettingsValuesSchema.safeParse({ a: 'x'.repeat(501) }).success).toBe(false)
  })

  it('turns a tile server into one image source for the frame CSP, nothing more', () => {
    expect(cspImageSource('https://{s}.tile.example.org/{z}/{x}/{y}.png')).toBe('https://*.tile.example.org')
    expect(cspImageSource('https://tiles.example.org:8443/{z}/{x}/{y}.png')).toBe(
      'https://tiles.example.org:8443',
    )
    expect(cspImageSource('http://localhost:8080/{z}/{x}/{y}.png')).toBe('http://localhost:8080')
    for (const bad of [
      'https://*.example.org/x.png',
      'https://a{s}.example.org/x.png',
      'nope',
      'https://example.org;/x',
    ])
      expect(cspImageSource(bad), bad).toBeNull()
  })

  // Security audit 2026-10-16 (M1): a plugin may send what it reads to its tile server, in an image's
  // address — over plain http anyone on the way reads it; `{s}.com` was every .com host.
  it('takes plain http for this computer only, and no subdomain wildcard over a bare name', () => {
    expect(cspImageSource('http://127.0.0.1:8080/{z}/{x}/{y}.png')).toBe('http://127.0.0.1:8080')
    expect(cspImageSource('http://[::1]:8080/{z}/{x}/{y}.png')).toBe('http://[::1]:8080')
    expect(cspImageSource('http://LOCALHOST/{z}.png')).toBe('http://localhost')
    for (const bad of [
      'http://tiles.example.org/{z}/{x}/{y}.png',
      'http://{s}.tile.example.org/{z}.png',
      'http://10.0.0.5/{z}.png',
      'http://localhost.example.org/{z}.png',
      'http://127.0.0.1.nip.io/{z}.png',
      'https://{s}.com/{z}.png',
      'https://{s}.localhost/{z}.png',
      'https://{s}.10.0.0.5/{z}.png',
      'http://[::2]/{z}.png',
      'http://{s}.localhost/{z}.png',
    ])
      expect(cspImageSource(bad), bad).toBeNull()
    const values = pluginSettingsSchema({ tileUrl: { type: 'url', title: { en: 'Tiles' } } })
    expect(values.safeParse({ tileUrl: 'http://tiles.example.org/{z}.png' }).success).toBe(false)
    expect(values.safeParse({ tileUrl: 'http://localhost:8080/{z}.png' }).success).toBe(true)
  })
})

// Security audit 2026-10-16 (M2): characters that show as nothing passed the spoofing filter.
describe('invisible characters', () => {
  it('knows the characters that show as nothing, apart from those that fake a name’s form', () => {
    const invisible = [
      0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x200b, 0x200c, 0x200d, 0x2060,
      0x2064, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0x1d173, 0x1d17a,
      0xe0000, 0xe0041, 0xe007f, 0xe0100, 0xe01ef,
    ]
    for (const code of invisible) {
      expect(isInvisibleChar(code), code.toString(16)).toBe(true)
      expect(isHiddenChar(code), code.toString(16)).toBe(true)
    }
    for (const code of [0x41, 0x20, 0xe9, 0x131, 0x4e00, 0x1f600, 0x2065, 0xfe10, 0xe0080])
      expect(isInvisibleChar(code), code.toString(16)).toBe(false)
    // A direction mark is hidden too, as isSpoofingChar says.
    expect(isHiddenChar(0x202e)).toBe(true)
    expect(isInvisibleChar(0x202e)).toBe(false)
  })

  // Review of the security pass (Minor): blanks the first list missed.
  it('knows the braille blank and the shorthand and hieroglyph format controls', () => {
    for (const code of [0x2800, 0x1bca0, 0x1bca3, 0x13430, 0x1343f])
      expect(isInvisibleChar(code), code.toString(16)).toBe(true)
    expect(isInvisibleChar(0x2801)).toBe(false)
  })

  // Review of the security pass (Minor): an emoji's own joiner and presentation selector were spelled
  // out in AI answers and READMEs; inside an emoji they hide nothing.
  it('leaves an emoji’s joiner and presentation selector alone, and catches them anywhere else', () => {
    const hiddenIn = (text: string) =>
      [...text].flatMap((c, i, all) => (isHiddenAt(all, i) ? [c.codePointAt(0)!.toString(16)] : []))
    expect(hiddenIn('👩\u200d💻 ❤\ufe0f 👍🏽 🏳\ufe0f\u200d🌈')).toEqual([])
    expect(hiddenIn('ad\u200dmin')).toEqual(['200d'])
    expect(hiddenIn('a\ufe0f')).toEqual(['fe0f'])
    expect(hiddenIn('👩\u200d')).toEqual(['200d'])
    expect(hiddenIn('\u200d💻')).toEqual(['200d'])
    expect(hiddenIn('👩\u200b💻 x\u202ey')).toEqual(['200b', '202e'])
  })
})

// Security audit 2026-10-16 (M5): a plugin's name is shown on its toasts and questions — never one
// that reads as the app's own.
describe('a plugin’s name', () => {
  const named = (en: string, tr?: string, id = 'geojson-map') =>
    PluginManifestSchema.safeParse(manifest({ id, name: tr === undefined ? { en } : { en, tr } })).success
  it('is never the app’s, MongoDB’s or a part of the app, however written', () => {
    for (const name of [
      'Mongo Manager',
      'mongo  manager',
      'MongoManager',
      'MONGO-MANAGER',
      'Mongo Manager:',
      'M\u043engo Manager', // a Cyrillic \u043e
      'M0ng0 Manager',
      'Ｍｏｎｇｏ Ｍａｎａｇｅｒ', // fullwidth
      'Mongo\u200bManager',
      'MongoDB',
      'Mongo DB',
      'System',
      'SYSTEM',
      'Sistem',
      'Session',
      'Security',
      'Güvenlik',
      'Admin',
      'Administrator',
      'Yönetici',
      'Oturum',
    ])
      expect(named(name), name).toBe(false)
    expect(named('Map', 'Mongo Manager')).toBe(false)
    for (const name of ['Map', 'SQL to MongoDB', 'Value search', 'Schema health', 'Document diff'])
      expect(named(name), name).toBe(true)
  })

  // Languages (2026-10-29): the app speaks ten languages, so a name never reads as its own words in
  // any of them, and a name may be given in each.
  it('is never the app’s own words in any of its languages, and is given in each', () => {
    for (const name of [
      '系统',
      '安全',
      '管理员',
      '插件',
      'システム',
      'セキュリティ',
      'ｾｷｭﾘﾃｨ', // half-width katakana
      'プラグイン',
      '보안',
      '시스템',
      'Безопасность',
      'СИСТЕМА',
      'Обновление',
      'Sicherheit',
      'Seguridad',
      'Sécurité',
      'Segurança',
      'Administrateur',
      'Actualización',
      'Atualização',
      'Anmeldung',
    ])
      expect(named(name), name).toBe(false)
    for (const name of ['地图', '图表', 'グラフ', '차트', 'Gráficos', 'Diagramme', 'Graphiques', 'Графики'])
      expect(named(name), name).toBe(true)
    // Review of the languages (minor 8): Traditional Chinese, Japanese variants, "extension" and
    // "notification" in every script, Russian "админ".
    for (const name of [
      '系統',
      '管理員',
      '伺服器',
      '錯誤',
      '登入',
      '外掛',
      'サーバ',
      'セキュリティー',
      'お知らせ',
      '扩展',
      '拡張機能',
      '확장',
      'Расширение',
      'Extensão',
      'Notification',
      'Notificación',
      'Notificação',
      'Benachrichtigung',
      'Админ',
    ])
      expect(named(name), name).toBe(false)
    // Review of the languages (minor 9): Latin beside Han, Kana or Hangul reads as neither; Latin
    // beside Cyrillic, Greek or Armenian letters still is refused.
    for (const name of ['GeoJSON地图', '旧版UUID', 'SQLクエリ', 'JSON뷰어'])
      expect(named(name), name).toBe(true)
    for (const name of ['Mapа', 'GeoΑ', 'Mapօ']) expect(named(name), name).toBe(false)
    const all = {
      en: 'Map',
      tr: 'Harita',
      zh: '地图',
      ja: '地図',
      es: 'Mapa',
      pt: 'Mapa',
      ko: '지도',
      de: 'Karte',
      fr: 'Carte',
      ru: 'Карта',
    }
    expect(PluginManifestSchema.safeParse(manifest({ id: 'geojson-map', name: all })).success).toBe(true)
    expect(
      PluginManifestSchema.safeParse(manifest({ id: 'geojson-map', name: { ...all, ja: 'システム' } }))
        .success,
    ).toBe(false)
    expect(
      PluginManifestSchema.safeParse(manifest({ id: 'geojson-map', name: { ...all, xx: 'Map' } })).success,
    ).toBe(false)
  })

  // Review of the security pass (Minor): letters of one script among another's passed — a Greek Nu,
  // an Upsilon, a Cyrillic Ue, an Armenian o — and a name could fake the id shown beside it.
  it('mixes no scripts, and holds no brackets that could fake the id shown beside it', () => {
    for (const name of [
      'MO\u039dGO MANAGER',
      'S\u03a5STEM',
      'S\u04aeSTEM',
      'M\u0585ngo Manager',
      'Value Search (value-search)',
      'Value Search [value-search]',
      'Map {time-hints}',
      'Map ( geojson-map )',
    ])
      expect(named(name), name).toBe(false)
    // One script, any of them; Turkish letters are Latin; digits and signs belong to none.
    for (const name of [
      'К\u0430рт\u0430',
      'Χάρτης',
      'Şema sağlığı',
      'Değer arama',
      '地図',
      'SQL → MongoDB 2',
    ])
      expect(named(name), name).toBe(true)
  })

  // Second review (Minor): the script rule is a word's, a bracket only refused around what reads as
  // an id, an emoji is no hidden character, and Latin letters that look like others are folded.
  it('checks scripts word by word, brackets around an id only, and takes an emoji', () => {
    for (const name of [
      'SQL クエリ',
      'Map 地図',
      'μ-stats',
      'Document diff (beta)',
      'Charts (2)',
      '\u{1f5fa}\ufe0f Map',
      'Sığ arama',
    ])
      expect(named(name), name).toBe(true)
    for (const name of [
      'MO\u039dGO tools',
      'Mongo Mana\u0261er',
      'Mongo M\u0251nager',
      '\u1d0dongo manager',
      'Sy\ua731tem',
      'Se\u0280ver',
    ])
      expect(named(name), name).toBe(false)
  })

  it('takes no invisible characters', () => {
    expect(named('Ma\u200bp')).toBe(false)
    expect(named('Map\ufe0f')).toBe(false)
    expect(named('Map\u{e0041}')).toBe(false)
  })

  it('is no id that reads as the app’s', () => {
    for (const id of ['mongo-manager', 'mongodb', 'system', 'admin', 'security', 'session'])
      expect(named('Map', undefined, id), id).toBe(false)
  })
})

// User request 2026-10-10: who made a plugin, when, its release notes — each bounded and safe.
describe('what a plugin says about itself', () => {
  const ok = (over: Record<string, unknown>) => PluginManifestSchema.safeParse(manifest(over)).success

  it('takes an author, addresses, a license, a date and release notes', () => {
    const parsed = PluginManifestSchema.parse(
      manifest({
        version: '1.0.3',
        author: { name: 'Gokhan Ozgezer', url: 'https://example.org' },
        homepage: 'https://example.org/plugin',
        repository: 'https://github.com/someone/plugin',
        license: 'MIT',
        publishedAt: '2026-10-20',
        changelog: [
          { version: '1.0.3', date: '2026-10-20', notes: { en: 'Faster.', tr: 'Daha hızlı.' } },
          { version: '1.0.2', date: '2026-10-01', notes: { en: 'First.' } },
        ],
      }),
    )
    expect(parsed.author?.name).toBe('Gokhan Ozgezer')
    expect(parsed.changelog).toHaveLength(2)
    expect(ok({})).toBe(true)
  })

  it('refuses addresses that are not https, carry credentials or are no address', () => {
    for (const url of [
      'http://example.org',
      'javascript:alert(1)',
      'https://user:pw@example.org',
      'example.org',
      'https://',
    ])
      expect(ok({ homepage: url }), url).toBe(false)
    expect(ok({ author: { name: 'A', url: 'ftp://x.org' } })).toBe(false)
    expect(ok({ repository: `https://example.org/${'a'.repeat(300)}` })).toBe(false)
  })

  // Review M8, M9: an address as written is the address used; a day in this world; notes up to the version.
  it('refuses an address a browser would read otherwise, a far day, notes past the version', () => {
    for (const url of [
      ' https://x.org',
      'https://x.org ',
      'https://ev il.org',
      'https:evil.com',
      'https:\\evil.com',
      'https://:@evil.com',
      'https://evil.com@x.org',
      'https://x.org/\\a',
      'https://x.org/\ta',
    ])
      expect(ok({ homepage: url }), JSON.stringify(url)).toBe(false)
    expect(ok({ homepage: 'https://x.org' })).toBe(true)
    expect(ok({ repository: 'https://github.com/owner/repo' })).toBe(true)
    for (const publishedAt of ['0000-01-01', '1899-12-31', '2101-01-01'])
      expect(ok({ publishedAt }), publishedAt).toBe(false)
    expect(ok({ license: '(MIT OR Apache-2.0)' })).toBe(true)
    expect(ok({ license: '(MIT OR Apache-2.0' })).toBe(false)
    expect(
      ok({ version: '1.0.0', changelog: [{ version: '1.1.0', date: '2026-10-20', notes: { en: 'x' } }] }),
    ).toBe(false)
  })

  it('refuses a date that is no day, a license that is no expression, odd names', () => {
    for (const publishedAt of ['2026-13-01', '2026-02-30', '20.10.2026', '2026-1-1'])
      expect(ok({ publishedAt }), publishedAt).toBe(false)
    for (const license of ['', 'MIT; rm -rf', 'a'.repeat(41), 'MIT\nX'])
      expect(ok({ license }), license).toBe(false)
    expect(ok({ license: 'Apache-2.0 OR MIT' })).toBe(true)
    expect(ok({ author: { name: 'evil\u202Etxt' } })).toBe(false)
    expect(ok({ author: { name: 'A', extra: 1 } })).toBe(false)
  })

  it('bounds the release notes: 50 entries, unique versions, 1000 characters each', () => {
    const entry = (version: string) => ({ version, date: '2026-10-20', notes: { en: 'x' } })
    expect(ok({ changelog: Array.from({ length: 51 }, (_, i) => entry(`1.0.${i}`)) })).toBe(false)
    expect(ok({ changelog: [entry('1.0.0'), entry('1.0.0')] })).toBe(false)
    expect(ok({ changelog: [{ ...entry('1.0.0'), notes: { en: 'x'.repeat(1001) } }] })).toBe(false)
    expect(ok({ changelog: [{ ...entry('1.0.0'), date: 'yesterday' }] })).toBe(false)
  })
})
