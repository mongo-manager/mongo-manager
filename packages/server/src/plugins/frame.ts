// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHmac, hkdfSync } from 'node:crypto'
import { cspImageSource, type PluginManifest } from '@mongo-manager/shared'
import { SESSION_ABSOLUTE_MS } from '../auth/sessions'
import { createSecretBox, type SecretBox } from '../crypto/secret-box'
import { safeEqual } from '../http/security'

/**
 * A frame's page loads within this; what it loads later (images, fonts, chunks) within the longer.
 * Review of the security pass (I5): the session a ticket names does the revoking, so its later
 * files are served as long as a session may last — an hour cut a kept page's lazy fonts off.
 */
export const PAGE_TICKET_MS = 10 * 60_000
export const ASSET_TICKET_MS = SESSION_ABSOLUTE_MS

/**
 * What a frame ticket names: the plugin, its version and approved files, when it was issued, and
 * the session it was issued in (security audit 2026-10-16), sealed — the plugin reads its own
 * address, so the session's hash is never in it as such. Empty without sign-in (local mode).
 */
export interface FrameTicket {
  p: string
  v: string
  d: string
  i: number
  s: string
}

/**
 * The key that seals a ticket's session: its own, never the signing key itself — derived once per
 * frame key, not at every file a frame loads.
 */
const boxes = new WeakMap<Buffer, SecretBox>()
function sessionBox(key: Buffer): SecretBox {
  let box = boxes.get(key)
  if (!box) {
    box = createSecretBox(
      Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'mm-plugin-frame-session-v1', 32)),
    )
    boxes.set(key, box)
  }
  return box
}
const SESSION_CONTEXT = 'plugin-frame-session'

/** A session's hash, sealed for a ticket. */
export const sealSession = (key: Buffer, idHash: string) => sessionBox(key).seal(idHash, SESSION_CONTEXT)

/** The session hash a ticket was sealed with, or null when it holds none or was not sealed here. */
export function openSession(key: Buffer, sealed: string): string | null {
  if (!sealed) return null
  try {
    return sessionBox(key).open(sealed, SESSION_CONTEXT)
  } catch {
    return null
  }
}

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url')

/** `<payload>.<mac>`: base64url JSON, signed with the frame key (never a session's). */
export function signTicket(key: Buffer, ticket: FrameTicket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
  return `${payload}.${mac(key, payload)}`
}

/** The ticket's content when its signature holds, else null. Its age is checked by the caller. */
export function readTicket(key: Buffer, text: string): FrameTicket | null {
  const m = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/.exec(text)
  if (!m || !safeEqual(mac(key, m[1]!), m[2]!)) return null
  try {
    const t = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as FrameTicket
    return typeof t.p === 'string' &&
      typeof t.v === 'string' &&
      typeof t.d === 'string' &&
      typeof t.s === 'string' &&
      Number.isFinite(t.i)
      ? t
      : null
  } catch {
    return null
  }
}

/**
 * Phase 4b §3: a plugin frame's policy. Sandboxed (scripts, an opaque origin) however the page is
 * opened — in a tab of its own too —, no network, its own files only, and the images of a server an
 * administrator set (a `url` setting, as one origin). Security audit 2026-10-16: `webrtc 'block'`
 * (CSP level 3) for the browsers that know it — Chromium 149 ignores it, so the scan flags WebRTC.
 */
export function frameCsp(
  manifest: PluginManifest,
  settings: Record<string, string | boolean>,
  /** `<scheme>://<host><base>/plugin-frame/<ticket>/`: the plugin's own files, never the whole app. */
  own: string,
): string {
  const images = new Set<string>()
  for (const [key, setting] of Object.entries(manifest.settings)) {
    const value = settings[key]
    if (setting.type !== 'url' || typeof value !== 'string') continue
    const source = cspImageSource(value)
    if (source) images.add(source)
  }
  return [
    "default-src 'none'",
    `script-src ${own}`,
    `style-src ${own}`,
    [`img-src ${own} data: blob:`, ...images].join(' '),
    `font-src ${own}`,
    "connect-src 'none'",
    "webrtc 'block'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts',
  ].join('; ')
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** Whether a file is a document a browser runs as a page (the short ticket window applies). */
export const isPage = (type: string) => type.startsWith('text/html') || type.startsWith('image/svg+xml')

/** A plugin file's type by its extension; anything else is bytes. */
export const typeOf = (path: string) => {
  const ext = path.split('.').pop()!.toLowerCase()
  // Own entries only: an extension like "__proto__" names no type.
  return Object.hasOwn(TYPES, ext) ? TYPES[ext]! : 'application/octet-stream'
}
