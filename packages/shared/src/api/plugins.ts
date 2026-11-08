// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import type { UiLanguage } from '../languages'
import { compareVersions } from './pluginVersions'
import { isHiddenAt, isSpoofingChar } from './gridfs'

/**
 * Phase 4b §2: plugins — a folder of static files and a manifest, run in a sandboxed frame. No code
 * runs on the server; what a plugin may read or change is what an administrator approved.
 */

export const PLUGIN_MANIFEST = 'mongo-manager-plugin.json'
/** At most this many files, this many bytes in all, in a plugin. */
export const PLUGIN_MAX_FILES = 500
export const PLUGIN_MAX_BYTES = 25 * 1024 * 1024
/** A path's depth inside a plugin. */
const MAX_DEPTH = 16

/** Lowercase letters and digits, dash-separated: `geojson-map`. */
export const PluginIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

/** Semantic versioning (major.minor.patch, an optional pre-release). */
export const PluginVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/)

/** Names Windows keeps for devices: never a file of a plugin, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
/** An object's own property names: never a file of a plugin (its files are kept by path). */
const PROPERTY = /^(__proto__|constructor|prototype)$/i

/**
 * A file's path in a plugin: relative, `/`-separated, each part plain characters — no `..`, `.`,
 * empty or hidden parts, no drive, no backslash, no device names.
 */
export const PluginPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((p) => {
    const parts = p.split('/')
    return (
      parts.length <= MAX_DEPTH &&
      parts.every(
        (s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(s) && !RESERVED.test(s) && !PROPERTY.test(s),
      )
    )
  }, 'Not a plain relative path')

/** Text a person reads: no characters that hide or fake its form. */
const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => ![...s].some((c) => isSpoofingChar(c.codePointAt(0)!)), 'Control characters')

/** English always; each other language of the app when given (English shown otherwise). */
export const LocalizedTextSchema = (max: number) =>
  z.strictObject({
    en: plainText(max),
    tr: plainText(max).optional(),
    zh: plainText(max).optional(),
    ja: plainText(max).optional(),
    es: plainText(max).optional(),
    pt: plainText(max).optional(),
    ko: plainText(max).optional(),
    de: plainText(max).optional(),
    fr: plainText(max).optional(),
    ru: plainText(max).optional(),
  })
export type LocalizedText = { en: string } & Partial<Record<Exclude<UiLanguage, 'en'>, string>>

/**
 * Letters that look like Latin ones (Cyrillic, Greek, Turkish dotless i), by code point — written as
 * themselves they would read as the Latin ones —, and digits or signs read as letters. Second review:
 * Latin letters that look like others too — script a and g, small capitals, the dotless i of Turkish
 * read as i (for this comparison only: a Turkish name is never refused for it).
 */
const LOOKALIKE_CODES = [
  '430 435 43e 440 441 443 445 456 458 455 501 4bb 4cf 43a 43c 442 432 43d 491 3bd 3bf 3b1 3c1 3c4 3b9',
  '3ba 3bc 3b5 3b2 3b7 131 30 31 33 35 24 40',
  '251 261 262 269 26a 274 280 28f 299 29c 29f 1d00 1d04 1d05 1d07 1d0a 1d0b 1d0d 1d0f 1d18 1d1b 1d1c',
  '1d20 1d21 1d22 a731',
].join(' ')
const LOOKALIKE_LATIN = 'aeopcyxijsdhlkmtbhrvoaptikmebniolessa' + 'aggiinrybhlacdejkmoptuvwzs'
const LOOKALIKES = new Map(
  LOOKALIKE_CODES.split(' ').map((hex, i) => [String.fromCodePoint(parseInt(hex, 16)), LOOKALIKE_LATIN[i]!]),
)
/** A name as it reads: compatibility forms and accents gone, lookalikes folded, letters only. */
const reading = (name: string) =>
  [...name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()]
    .map((c) => LOOKALIKES.get(c) ?? c)
    .join('')
    .replace(/[^a-z]/g, '')
/**
 * Security audit 2026-10-16 (M5): what a plugin may not be called — its name heads its messages and
 * questions ("Mongo Manager: sign in again…"). Compared as names read: case, spaces, accents,
 * lookalike letters and invisible characters aside. Languages (2026-10-29): in every language of the
 * app — the Latin ones here, the others below.
 */
const RESERVED_NAMES = new Set(
  [
    'mongo mongodb system sistem session oturum security guvenlik admin administrator administration',
    'yonetici yonetim app application uygulama server sunucu warning uyari error hata alert notice',
    'update guncelleme login signin giris auth authentication plugin plugins eklenti eklentiler',
    // Spanish and Brazilian Portuguese.
    'sistema sesion seguridad administrador administracion aplicacion servidor advertencia aviso',
    'alerta actualizacion iniciarsesion acceso autenticacion complemento complementos sessao seguranca',
    'administracao aplicativo aplicacao erro atualizacao entrar autenticacao',
    // German and French.
    'sitzung sicherheit verwaltung anwendung warnung fehler hinweis aktualisierung anmelden anmeldung',
    'authentifizierung erweiterung erweiterungen systeme securite administrateur serveur avertissement',
    'erreur alerte miseajour connexion seconnecter authentification extension extensions',
    // Review of the languages (minor 8): notification in the Latin languages, Portuguese extension.
    'notification notifications notificacion notificaciones notificacao notificacoes benachrichtigung',
    'benachrichtigungen extensao extensoes',
  ]
    .join(' ')
    .split(' '),
)
/** A name as it reads in any script: compatibility forms (half-width katakana) folded, letters only. */
const readingAny = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '')
/** The same words in Chinese, Japanese, Korean and Russian. */
const RESERVED_WORDS = new Set(
  [
    '系统 会话 安全 管理员 管理 应用 应用程序 服务器 警告 错误 提醒 通知 更新 登录 身份验证 认证 插件',
    'システム セッション セキュリティ 管理者 アプリ アプリケーション サーバー 警告 エラー アラート 通知',
    '更新 アップデート サインイン ログイン 認証 プラグイン',
    '시스템 세션 보안 관리자 관리 앱 애플리케이션 서버 경고 오류 알림 업데이트 로그인 인증 플러그인',
    'система сеанс сессия безопасность администратор администрирование приложение сервер',
    'предупреждение ошибка оповещение уведомление обновление вход войти аутентификация плагин плагины',
    // Review of the languages (minor 8): Traditional Chinese, Japanese variants, extension, админ.
    '系統 會話 管理員 應用 應用程式 伺服器 錯誤 提醒 登入 驗證 認證 外掛 擴充 扩展 拡張 拡張機能',
    'サーバ セキュリティー お知らせ 확장 расширение расширения админ',
  ]
    .join(' ')
    .split(' '),
)
export const isReservedPluginName = (name: string): boolean => {
  const read = reading(name)
  return RESERVED_NAMES.has(read) || read.startsWith('mongomanager') || RESERVED_WORDS.has(readingAny(name))
}
/**
 * Review of the security pass (Minor): one letter of another script among Latin ones (a Greek Nu in
 * "MONGO", an Armenian o) reads as the Latin letter it looks like, and the app's own names are Latin.
 * Second review: word by word ("SQL" beside a Japanese word, "μ-stats" are names) — a word's letters
 * are all Latin or none of them, never Greek and Cyrillic together.
 */
const plainWords = (name: string) =>
  name
    .split(/[^\p{L}\p{M}]+/u)
    .filter(Boolean)
    .every((word) => {
      // Review of the languages (minor 9): Han, Kana and Hangul look like no Latin letter, so Latin
      // beside them ("GeoJSON地图", "SQLクエリ") is plain; beside Cyrillic, Greek or Armenian it is not.
      const letters = [...word].filter(
        (c) =>
          /\p{L}/u.test(c) &&
          !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c),
      )
      const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length
      if (latin > 0 && latin < letters.length) return false
      return !(/\p{Script=Greek}/u.test(word) && /\p{Script=Cyrillic}/u.test(word))
    })
/**
 * A bracket around what reads as a plugin's id ("Value search (value-search)"): it would fake the id
 * the app shows beside the name. "(beta)" or "(2)" is no id of that form (second review).
 */
const FAKE_ID = /[([{]\s*[a-z0-9]+(?:-[a-z0-9]+)+\s*[)\]}]/
/** A plugin's name: plain text, nothing hidden (an emoji is not), never one the app keeps (M5). */
const PluginNameText = plainText(60).refine((s) => {
  const chars = [...s]
  return (
    !chars.some((_, i) => isHiddenAt(chars, i)) &&
    !isReservedPluginName(s) &&
    plainWords(s) &&
    !FAKE_ID.test(s)
  )
}, 'A name the app keeps, mixing scripts in a word, faking an id in brackets, or holding hidden characters')

/**
 * What a plugin may be approved to do. Plugins wave 2: `collection:read` (its collection's indexes)
 * and `database:read` (the other collections of its database: their names and documents), both
 * read as the user, with the user's rights and masking.
 */
export const PLUGIN_PERMISSIONS = [
  'documents:read',
  'documents:write',
  'collection:read',
  'database:read',
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** The icons a contribution may show (the app's own set; a plugin brings none). */
// Plugins wave 3: book, wand, shapes and scroll (the dictionary, test data, reshape, the log analyzer).
export const PLUGIN_ICONS = [
  'map',
  'chart',
  'table',
  'file',
  'image',
  'globe',
  'layers',
  'puzzle',
  'book',
  'wand',
  'shapes',
  'scroll',
  // Research plugins (review 2026-10-28): four tabs shared the scroll; each gets its own.
  'code',
  'calendar',
  'hourglass',
  'shield',
  'fingerprint',
  'ruler',
] as const
/** Which values a cell renderer is asked about. */
// Plugins wave 3: binary values (not UUIDs); a renderer is sent their head only (spec §1.4).
export const PLUGIN_CELL_MATCHES = [
  'geojson',
  'string',
  'number',
  'date',
  'object',
  'objectId',
  'binary',
] as const

/** A contribution's id within its plugin: `map`, `sql`. */
export const ContributionIdSchema = z
  .string()
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/)
const ContributionId = ContributionIdSchema
const MAX_PER_KIND = 5
const uniqueIds = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((i) => i.id)).size === items.length
const kind = <T extends z.ZodType<{ id: string }>>(item: T) =>
  z.array(item).max(MAX_PER_KIND).refine(uniqueIds, 'Two contributions share an id').default([])

const Titled = z.strictObject({
  id: ContributionId,
  title: LocalizedTextSchema(40),
  icon: z.enum(PLUGIN_ICONS).optional(),
})

export const PLUGIN_SETTING_TYPES = ['url', 'text', 'boolean'] as const
const SettingKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/)
const SettingSchema = z.strictObject({
  type: z.enum(PLUGIN_SETTING_TYPES),
  title: LocalizedTextSchema(60),
})

/**
 * An https address a plugin names (its author, home page, repository), used as written (review M8):
 * `https://` and a host, no credentials, no space, backslash or control character anywhere.
 */
const HttpsUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^\s\\@/?#]+([/?#][^\s\\]*)?$/)
  .refine((u) => {
    if ([...u].some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f)) return false
    try {
      const url = new URL(u)
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
    } catch {
      return false
    }
  }, 'An https address')
/** A day, as `YYYY-MM-DD`, that exists, between 1900 and 2100 (review M9). */
const Day = z
  .string()
  .regex(/^(19|20)\d{2}-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/)
  .refine((d) => {
    const at = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d
  }, 'A day that exists')
/** An SPDX-like license expression: `MIT`, `Apache-2.0 OR MIT`, `(MIT OR Apache-2.0)`. */
const License = z
  .string()
  .min(1)
  .max(40)
  .regex(/^\(*[A-Za-z0-9.+-]+\)*( (AND|OR|WITH) \(*[A-Za-z0-9.+-]+\)*)*$/)
  .refine((l) => {
    let depth = 0
    for (const c of l) {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0
      if (depth < 0) return false
    }
    return depth === 0
  }, 'Balanced parentheses')
/** One release's notes (user request 2026-10-10: "1.0.3, 20.10.2026: what changed"). */
const ChangelogEntry = z.strictObject({
  version: PluginVersionSchema,
  date: Day,
  notes: LocalizedTextSchema(1000),
})

export const PluginManifestSchema = z
  .strictObject({
    id: PluginIdSchema.refine((id) => !isReservedPluginName(id), 'An id the app keeps'),
    name: z.strictObject({
      en: PluginNameText,
      tr: PluginNameText.optional(),
      zh: PluginNameText.optional(),
      ja: PluginNameText.optional(),
      es: PluginNameText.optional(),
      pt: PluginNameText.optional(),
      ko: PluginNameText.optional(),
      de: PluginNameText.optional(),
      fr: PluginNameText.optional(),
      ru: PluginNameText.optional(),
    }),
    version: PluginVersionSchema,
    description: LocalizedTextSchema(300).optional(),
    /** The page every contribution opens (an `.html` file of the plugin). */
    entry: PluginPathSchema.refine((p) => p.endsWith('.html'), 'The entry is an .html file'),
    permissions: z
      .array(z.enum(PLUGIN_PERMISSIONS))
      .max(PLUGIN_PERMISSIONS.length)
      .refine((p) => new Set(p).size === p.length, 'A permission is named twice')
      .default([]),
    contributes: z
      .strictObject({
        collectionTabs: kind(Titled),
        documentActions: kind(Titled),
        sidebarPanels: kind(Titled),
        cellRenderers: kind(
          z.strictObject({
            id: ContributionId,
            match: z.enum(PLUGIN_CELL_MATCHES),
            /**
             * User request 2026-10-13: where the renderer's text is shown — beside the value, or in a
             * tooltip its cell or row shows when hovered or focused.
             */
            display: z.enum(['inline', 'tooltip']).default('inline'),
          }),
        ),
      })
      .default({ collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: [] }),
    settings: z
      .record(SettingKey, SettingSchema)
      .refine((s) => Object.keys(s).length <= 10, 'At most 10 settings')
      .default({}),
    // User request 2026-10-10: who made it, when, and what each release changed (all optional).
    author: z.strictObject({ name: plainText(80), url: HttpsUrl.optional() }).optional(),
    homepage: HttpsUrl.optional(),
    repository: HttpsUrl.optional(),
    license: License.optional(),
    publishedAt: Day.optional(),
    changelog: z
      .array(ChangelogEntry)
      .max(50)
      .refine((c) => new Set(c.map((e) => e.version)).size === c.length, 'A version is named twice')
      .optional(),
  })
  .refine((m) => !m.changelog || m.changelog.every((e) => compareVersions(e.version, m.version) <= 0), {
    message: 'A release note is for a version after this one',
    path: ['changelog'],
  })
export type PluginManifest = z.infer<typeof PluginManifestSchema>

/** A tile server address: http(s), no credentials, no characters a policy or a URL would misread. */
const TileUrl = z
  .string()
  .max(500)
  .refine(
    (u) => cspImageSource(u) !== null,
    'Not an https address of a tile server (plain http only for this computer)',
  )

/** Any plugin's stored values: bounded before they are checked against its manifest. */
export const PluginSettingsValuesSchema = z
  .record(SettingKey, z.union([z.string().max(500), z.boolean()]))
  .refine((v) => Object.keys(v).length <= 10, 'At most 10 settings')

/** The values a plugin's declared settings take: only those, each of its own type. */
export function pluginSettingsSchema(declared: PluginManifest['settings']) {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, setting] of Object.entries(declared))
    shape[key] = (
      setting.type === 'boolean' ? z.boolean() : setting.type === 'url' ? TileUrl : plainText(500)
    ).optional()
  return z.strictObject(shape)
}

/** This computer, the one place plain http may reach (security audit 2026-10-16, M1). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The one image source a tile server adds to a plugin frame's policy: its scheme, host and port.
 * A leading `{s}.` (a subdomain chosen per tile) becomes `*.`; any other placeholder or odd
 * character in the host, credentials, or a scheme but http(s) give none. Security audit 2026-10-16
 * (M1): the plugin may send what it reads to that server, in an image's address — so plain http
 * only to this computer (anyone on the way reads it otherwise), and `{s}.` only before a name of
 * two parts or more, never an address or `localhost` (`*.com` would be every .com host).
 */
export function cspImageSource(template: string): string | null {
  const m = /^(https?):\/\/(\{s\}\.)?([a-z0-9.-]+|\[::1\])(:\d{1,5})?(\/[^\s'";,]*)?$/i.exec(template)
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  const host = m[3]!.toLowerCase()
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null
  if (scheme === 'http' && !LOOPBACK.has(host)) return null
  if (m[2] && (!host.includes('.') || /^[\d.]+$/.test(host) || host.endsWith('.localhost'))) return null
  const port = m[4] ?? ''
  if (port && Number(port.slice(1)) > 65535) return null
  return `${scheme}://${m[2] ? '*.' : ''}${host}${port}`
}

export type PluginSource = 'folder' | 'upload' | 'bundled'

/** Where an uploaded plugin came from (user request 2026-10-11): a GitHub repository's release. */
export interface PluginOrigin {
  kind: 'github'
  /** owner/repository */
  repository: string
  release: string
  asset: string
  /** The release's page. */
  url: string
}

/** User request 2026-10-11: a plugin installed from a public GitHub repository's release. */
export const PluginGithubInstallSchema = z.strictObject({ url: z.string().min(1).max(400) })

/** A plugin as its administrators see it. */
export interface PluginAdminView {
  id: string
  source: PluginSource
  /** Null when the folder holds no valid manifest (see `error`). */
  manifest: PluginManifest | null
  /** The SHA-256 of all its files (what an approval is for). */
  digest: string | null
  fileCount: number
  bytes: number
  enabled: boolean
  /** What was approved, and whether it was for these very files. */
  approvedPermissions: PluginPermission[]
  approvedCurrent: boolean
  /** Asked for and never approved. */
  newPermissions: PluginPermission[]
  settings: Record<string, string | boolean>
  installedBy: string | null
  installedAt: number
  updatedAt: number
  error: string | null
  /** A bundled plugin's version before an update that kept its approval (user request 2026-10-10). */
  updatedFrom: string | null
  /** Whether it has a README.md (read on its details page). */
  readme: boolean
  /** What its files were found to try; null when they could not be read. */
  scan: PluginScan | null
  /** Where it was installed from, when that was GitHub. */
  origin: PluginOrigin | null
  /** Its approval moved to these files on its own, as a bundled update asking nothing more. */
  approvalCarried: boolean
}

/** User request 2026-10-11: what a plugin's files were found to try, before it is approved. */
export type PluginScanSeverity = 'high' | 'medium' | 'low' | 'info'
export interface PluginScanFinding {
  /** code-from-text, html-injection, remote-code, escape-attempt, packed-code, webrtc, prefetch-hint, network, inline-handler, workers, write-permission, storage, minified, data-blob */
  rule: string
  severity: PluginScanSeverity
  file: string
  line: number
  /** The line around it, as plain text (no control or hidden characters), at most 160 characters. */
  excerpt: string
}
export interface PluginScan {
  /** Most serious first; at most 10 of one rule in one file. */
  findings: PluginScanFinding[]
  /** Every finding, listed or not. */
  counts: Record<PluginScanSeverity, number>
  truncated: boolean
}

/** An enabled plugin as every signed-in user's app sees it: what it adds and may do. */
export interface PluginRuntimeView {
  id: string
  version: string
  name: LocalizedText
  entry: string
  permissions: PluginPermission[]
  contributes: PluginManifest['contributes']
  /** What an administrator set (a tile server…): the plugin reads them through the bridge. */
  settings: Record<string, string | boolean>
}

export const PluginApproveSchema = z.strictObject({
  /** The files the administrator saw: approving other files is refused. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Its id, typed by the administrator, when its scan found high risks (user request 2026-10-11). */
  acceptRisk: z.string().max(64).optional(),
})
