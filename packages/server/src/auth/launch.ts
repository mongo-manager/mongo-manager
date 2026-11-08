// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  UI_LANGUAGE_TAGS,
  parseAcceptLanguage,
  uiLanguageFromTags,
  type UiLanguage,
} from '@mongo-manager/shared'
import { ensureDataDir } from '../store/datadir'
import { createWhole } from '../store/key-file'
import { safeEqual } from '../http/security'

/**
 * Security audit 2026-10-16 (important 2): local mode has no accounts, so every process and every
 * account on the computer that could reach the port was its owner. Now a browser gets in only with
 * a cookie it receives for a one-time launch link, and only who can read the data directory (the
 * account that runs Mongo Manager, and administrators) can make such a link: from the per-install
 * secret kept there (owner-only, made like secret.key). The server prints one at start;
 * `mongo-manager open` makes one for a running server.
 */
export const LAUNCH_FILE = 'launch.key'
const SECRET_BYTES = 32
/** A link the server prints at start (for a person to open), and one `open` makes (opened at once). */
export const LAUNCH_TTL_START_MS = 60 * 60_000
export const LAUNCH_TTL_OPEN_MS = 2 * 60_000
/** A clock between the CLI and the server may differ a little. */
const SKEW_MS = 60_000
/** How long the browser keeps the cookie; renewed whenever the app starts in it. */
export const LOCAL_COOKIE_MAX_AGE_S = 180 * 24 * 3600

const keys = (secret: Buffer) => ({
  token: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mm-launch-token-v1', 32)),
  cookie: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mm-local-cookie-v1', 32)),
})
const mac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('base64url')

/** The secret as the file holds it (base64); `path` names it in the error. */
export function parseLaunchSecret(text: string, path: string): Buffer {
  const secret = Buffer.from(text.trim(), 'base64')
  if (secret.length !== SECRET_BYTES) throw new Error(`${path} does not hold a ${SECRET_BYTES}-byte secret`)
  return secret
}

/** The secret of this installation, or null when it was never made (local mode never ran). */
export function readLaunchSecret(dataDir: string): Buffer | null {
  const path = join(dataDir, LAUNCH_FILE)
  return existsSync(path) ? parseLaunchSecret(readFileSync(path, 'utf8'), path) : null
}

/** Made once, owner-only, in the data directory (as secret.key is). */
export function loadOrCreateLaunchSecret(dataDir: string): Buffer {
  const path = join(dataDir, LAUNCH_FILE)
  const existing = readLaunchSecret(dataDir)
  if (existing) return existing
  ensureDataDir(dataDir)
  const secret = randomBytes(SECRET_BYTES)
  if (createWhole(path, `${secret.toString('base64')}\n`) === 'exists')
    return parseLaunchSecret(readFileSync(path, 'utf8'), path)
  return secret
}

/** A one-time launch token: `<expiry, base 36>.<nonce>.<mac>` (URL-safe, nothing to escape). */
export function mintLaunchToken(secret: Buffer, now: number, ttlMs = LAUNCH_TTL_OPEN_MS): string {
  return mintToken(secret, now, ttlMs, 'launch')
}

/**
 * Second review (minor 3): a one-time token of another kind, with which `mongo-manager
 * forget-browsers` asks a running server to sign every browser out (and end the local shells).
 */
export function mintForgetToken(secret: Buffer, now: number, ttlMs = LAUNCH_TTL_OPEN_MS): string {
  return mintToken(secret, now, ttlMs, 'forget')
}

type TokenPurpose = 'launch' | 'forget'

function mintToken(secret: Buffer, now: number, ttlMs: number, purpose: TokenPurpose): string {
  const payload = `${(now + ttlMs).toString(36)}.${randomBytes(16).toString('base64url')}`
  return `${payload}.${mac(keys(secret).token, `${purpose}|${payload}`)}`
}

/**
 * Review of the audit fixes (important 1): a cookie on 127.0.0.1 goes to every port of it — to
 * another account's server there too — so the cookie alone opens nothing. Each browser that opens a
 * launch link gets a random cookie of its own (kept here only as a hash, revocable), named for this
 * installation (two on one computer never overwrite each other's), and claims once, right after, a
 * key of its own that its page keeps in its origin's storage (per port) and sends with every API
 * request as `x-mm-local`. The socket's hello needs the CSRF token, which only a request with the key
 * gets; a download link carries a one-time ticket the page asks for with the key.
 */
export const LOCAL_KEY_HEADER = 'x-mm-local'
/** A browser claims its key within this long of opening its link (its page does so at once). */
export const CLAIM_MS = 5 * 60_000
/** A browser unused this long is forgotten (its cookie lives as long; both renewed on use). */
export const LOCAL_IDLE_MS = LOCAL_COOKIE_MAX_AGE_S * 1000
const TICKET_MS = 60_000
const TOUCH_MS = 3600_000

const sha = (text: string) => createHash('sha256').update(text).digest('base64url')

/** The name of this installation's local cookie (before its __Host-/__Secure- prefix over HTTPS). */
export function localCookieName(secret: Buffer): string {
  return `mm_local_${mac(keys(secret).cookie, 'install-id').slice(0, 10)}`
}

/** The page's words in each language of the app but English: title, text, link. */
const REFUSED: Record<Exclude<UiLanguage, 'en'>, [string, string, string]> = {
  tr: [
    'Bu bağlantıyı Mongo Manager’dan açın',
    'Yerel modda bir indirme bağlantısı yalnızca Mongo Manager’ın içinde tıklandığında çalışır. Ona dönüp bağlantıya orada tıklayın (ya da menüsünü yeniden açın).',
    'Mongo Manager’ı aç',
  ],
  zh: [
    '请在 Mongo Manager 中打开此链接',
    '在本地模式下，下载链接只有在 Mongo Manager 内点击时才有效。请返回 Mongo Manager，在那里点击该链接（或重新打开其菜单）。',
    '打开 Mongo Manager',
  ],
  ja: [
    'このリンクは Mongo Manager から開いてください',
    'ローカルモードでは、ダウンロードリンクは Mongo Manager の中でクリックした場合にのみ機能します。Mongo Manager に戻り、そこでリンクをクリックしてください（またはメニューをもう一度開いてください）。',
    'Mongo Manager を開く',
  ],
  es: [
    'Abre este enlace desde Mongo Manager',
    'En el modo local, un enlace de descarga solo funciona cuando se hace clic en él dentro de Mongo Manager. Vuelve a la aplicación y haz clic en el enlace allí (o abre su menú de nuevo).',
    'Abrir Mongo Manager',
  ],
  pt: [
    'Abra este link pelo Mongo Manager',
    'No modo local, um link de download só funciona quando clicado dentro do próprio Mongo Manager. Volte para ele e clique no link lá (ou abra o menu dele novamente).',
    'Abrir o Mongo Manager',
  ],
  ko: [
    '이 링크는 Mongo Manager에서 여세요',
    '로컬 모드에서는 다운로드 링크가 Mongo Manager 안에서 클릭했을 때만 작동합니다. Mongo Manager로 돌아가 그곳에서 링크를 클릭하세요(또는 메뉴를 다시 여세요).',
    'Mongo Manager 열기',
  ],
  de: [
    'Öffnen Sie diesen Link in Mongo Manager',
    'Im lokalen Modus funktioniert ein Download-Link nur, wenn er in Mongo Manager selbst angeklickt wird. Kehren Sie dorthin zurück und klicken Sie dort auf den Link (oder öffnen Sie sein Menü erneut).',
    'Mongo Manager öffnen',
  ],
  fr: [
    'Ouvrez ce lien depuis Mongo Manager',
    'En mode local, un lien de téléchargement ne fonctionne que si l’on clique dessus dans Mongo Manager. Revenez-y et cliquez sur le lien (ou rouvrez son menu).',
    'Ouvrir Mongo Manager',
  ],
  ru: [
    'Откройте эту ссылку в Mongo Manager',
    'В локальном режиме ссылка на скачивание работает, только если нажать её в самом Mongo Manager. Вернитесь в него и нажмите ссылку там (или снова откройте её меню).',
    'Открыть Mongo Manager',
  ],
}

/** The first of the browser's languages the page has, by the app's one rule; English otherwise. */
const preferred = (acceptLanguage: string | undefined): UiLanguage =>
  uiLanguageFromTags(parseAcceptLanguage(acceptLanguage)) ?? 'en'

/**
 * Second review (N2): what a browser that followed a download link without its ticket sees (a link
 * opened in a new tab before the page could add it). Languages (2026-10-29): in the browser's own
 * language first when the app has it, and in English always; no script, no style (the app's policy
 * allows neither inline).
 */
export function linkRefusedPage(basePath: string, acceptLanguage?: string): string {
  const home = basePath.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const language = preferred(acceptLanguage)
  const words = language === 'en' ? null : REFUSED[language]
  const tag = UI_LANGUAGE_TAGS[language]
  const theirs = words
    ? `<h1 lang="${tag}">${words[0]}</h1><p lang="${tag}">${words[1]} <a href="${home}">${words[2]}</a></p>`
    : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<title>Mongo Manager</title></head><body>' +
    theirs +
    '<h1>Open this link from Mongo Manager</h1>' +
    '<p>In local mode a download link works only when clicked in Mongo Manager itself. Go back to it ' +
    `and click the link there (or open its menu again). <a href="${home}">Open Mongo Manager</a></p>` +
    '</body></html>\n'
  )
}

/** A browser that opened a launch link, as the store keeps it. */
export interface LocalBrowser {
  idHash: string
  /** The hash of its page's key; null until claimed. */
  keyHash: string | null
  createdAt: number
}

/** The launch tokens and the browsers of local mode, for one data directory. */
export class LaunchGate {
  private readonly tokenKey: Buffer
  readonly cookieName: string
  /** One-time download tickets: ticket → browser and path. */
  private readonly tickets = new Map<string, { idHash: string; path: string; expiresAt: number }>()
  private readonly revokeListeners = new Set<() => void>()

  constructor(
    private readonly secret: Buffer,
    private readonly now: () => number,
    private readonly db: DatabaseSync,
  ) {
    this.tokenKey = keys(secret).token
    this.cookieName = localCookieName(secret)
  }

  /** A token for this server's own start-up line. */
  mint(ttlMs: number): string {
    return mintLaunchToken(this.secret, this.now(), ttlMs)
  }

  /** Whether the token is one this installation made (its MAC), whatever else. */
  ours(token: string, purpose: TokenPurpose = 'launch'): boolean {
    const parts = token.split('.')
    if (parts.length !== 3 || token.length > 200) return false
    const [expiry, nonce, given] = parts as [string, string, string]
    return safeEqual(given, mac(this.tokenKey, `${purpose}|${expiry}.${nonce}`))
  }

  /**
   * True once for a valid, unexpired token; it is used up then — for good: the used nonces are kept
   * in the store until they expire, so a restart never takes one again (review of the audit fixes,
   * important 2).
   */
  take(token: string, purpose: TokenPurpose = 'launch'): boolean {
    if (!this.ours(token, purpose)) return false
    const [expiry, nonce] = token.split('.') as [string, string]
    const exp = Number.parseInt(expiry, 36)
    const t = this.now()
    // Unexpired, and never one meant to last longer than a link ever does.
    if (!Number.isFinite(exp) || exp <= t || exp > t + LAUNCH_TTL_START_MS + SKEW_MS) return false
    this.db.prepare('DELETE FROM launch_nonces WHERE expires_at <= ?').run(t)
    const added = this.db
      .prepare('INSERT OR IGNORE INTO launch_nonces (nonce, expires_at) VALUES (?, ?)')
      .run(nonce, exp).changes
    return Number(added) === 1
  }

  /** A new browser, for a link just taken: its cookie's value. */
  open(userAgent: string | undefined): string {
    const id = randomBytes(32).toString('base64url')
    const t = this.now()
    this.db
      .prepare(
        'INSERT INTO local_browsers (id_hash, key_hash, created_at, last_seen_at, user_agent) VALUES (?, NULL, ?, ?, ?)',
      )
      .run(sha(id), t, t, userAgent?.slice(0, 256) ?? null)
    return id
  }

  /** The browser of this cookie, while it is kept. */
  browser(cookie: string | undefined): LocalBrowser | null {
    if (!cookie || cookie.length > 100) return null
    const idHash = sha(cookie)
    const row = this.db
      .prepare('SELECT key_hash, created_at, last_seen_at FROM local_browsers WHERE id_hash = ?')
      .get(idHash) as { key_hash: string | null; created_at: number; last_seen_at: number } | undefined
    const t = this.now()
    if (!row || t - row.last_seen_at > LOCAL_IDLE_MS) return null
    if (t - row.last_seen_at >= TOUCH_MS)
      this.db.prepare('UPDATE local_browsers SET last_seen_at = ? WHERE id_hash = ?').run(t, idHash)
    return { idHash, keyHash: row.key_hash, createdAt: row.created_at }
  }

  /** Whether a browser is still kept (a socket asks before every push). */
  alive(idHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM local_browsers WHERE id_hash = ?').get(idHash) !== undefined
  }

  /** The browser's page key, once, within CLAIM_MS of its link; null otherwise. */
  claim(browser: LocalBrowser): string | null {
    if (browser.keyHash !== null || this.now() - browser.createdAt > CLAIM_MS) return null
    const key = randomBytes(32).toString('base64url')
    const changed = this.db
      .prepare('UPDATE local_browsers SET key_hash = ? WHERE id_hash = ? AND key_hash IS NULL')
      .run(sha(key), browser.idHash).changes
    return Number(changed) === 1 ? key : null
  }

  keyOk(browser: LocalBrowser, key: unknown): boolean {
    return (
      typeof key === 'string' &&
      browser.keyHash !== null &&
      key.length <= 100 &&
      safeEqual(sha(key), browser.keyHash)
    )
  }

  /** A one-time ticket for a download link to this path (the page asks with its key). */
  ticket(browser: LocalBrowser, path: string): string {
    const t = this.now()
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k)
    if (this.tickets.size > 1000) this.tickets.delete(this.tickets.keys().next().value!)
    const ticket = randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { idHash: browser.idHash, path, expiresAt: t + TICKET_MS })
    return ticket
  }

  /** True once for a ticket this browser asked for this very path, within a minute. */
  takeTicket(browser: LocalBrowser, ticket: string, path: string): boolean {
    const entry = this.tickets.get(ticket)
    if (!entry) return false
    this.tickets.delete(ticket)
    return safeEqual(entry.idHash, browser.idHash) && entry.path === path && entry.expiresAt > this.now()
  }

  /** Signs every browser out (the app's button, and `mongo-manager forget-browsers`). */
  forgetAll(): number {
    const n = Number(this.db.prepare('DELETE FROM local_browsers').run().changes)
    this.tickets.clear()
    for (const listener of this.revokeListeners) listener()
    return n
  }

  onForget(listener: () => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }
}
