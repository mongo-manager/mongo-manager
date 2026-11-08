// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  isSpoofingChar,
  type PluginManifest,
  type PluginScan,
  type PluginScanFinding,
  type PluginScanSeverity,
} from '@mongo-manager/shared'

/**
 * User request 2026-10-11 ("her eklentide aa evet yükle olmamalı"): every plugin's files are read for
 * what could run text as code, write markup from text, load code from elsewhere, try to leave its
 * frame, reach out, or hide what it does — before an administrator approves it. The sandbox stops
 * most of it anyway (no network, an opaque origin, its own page); the scan says what was tried, so
 * an approval is an informed one.
 *
 * Every pattern runs in linear time: no two adjacent parts may match the same characters (review
 * 2026-10-11: `\s*["']?\s*` split a run of spaces every way, and one line froze the server), and no
 * unbounded prefix like `<[^>]*`. A test feeds each pattern its own prefix and long runs of blanks.
 */

interface Rule {
  rule: string
  severity: PluginScanSeverity
  /** Which files it reads: script, markup (HTML, SVG) or style. */
  in: ReadonlyArray<'script' | 'markup' | 'style'>
  /** A pattern, or a check that says where in the line it found what it looks for (-1: not). */
  patterns: Array<RegExp | ((line: string) => number)>
}

/**
 * Where `pattern` (global) matches inside a tag whose name passes `tag`: after a `<` with no `>`
 * since. The text is walked once, alongside the matches, so it costs what it is long however many
 * candidates it holds. Run on a line, then on a markup file whole, for a tag over several lines.
 */
function inTag(pattern: RegExp, tag: RegExp): (text: string) => number {
  return (text) => {
    pattern.lastIndex = 0
    let walked = 0
    let open = -1
    let close = -1
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      for (; walked < m.index; walked++) {
        const c = text.charCodeAt(walked)
        if (c === 0x3c) open = walked
        else if (c === 0x3e) close = walked
      }
      if (open > close && tag.test(text.slice(open, open + 16))) return open
    }
    return -1
  }
}

/** `<script … src=//…`: a script from elsewhere. `[\s"']*` is one part: nothing to split. */
const REMOTE_SCRIPT = inTag(/\ssrc\s*=[\s"']*(?:https?:)?\/\//gi, /^<script\b/i)
/** `<tag … onclick=`: code in a markup attribute. */
const INLINE_HANDLER = inTag(/\son[a-z]+\s*=/gi, /^<[a-z]/i)
/** A quoted name in brackets: `['innerHTML']`. */
const NAMED = (names: string) => new RegExp(`\\[\\s*["'\`](?:${names})["'\`]\\s*\\]`)

const RULES: Rule[] = [
  {
    rule: 'code-from-text',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [
      /\beval\s*(?:\?\.\s*)?\(/,
      // eval reached indirectly, through a comma expression in parentheses or an array.
      /[(,[]\s*eval\s*[)\]]/,
      NAMED('eval|Function'),
      // The Function constructor, called bare or with new; another object's Function is its own.
      /(?<![.\w$])Function\s*\(/,
      // ...and through the global object, its own methods or Reflect (as the repository's gate).
      /\b(?:globalThis|window|self|global)\s*\.\s*Function\s*\(/,
      /\bFunction\s*\.\s*(?:apply|call|bind)\s*\(/,
      /\bReflect\s*\.\s*(?:apply|construct)\s*\(\s*(?:Function|eval)\b/,
      /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
    ],
  },
  {
    rule: 'html-injection',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [
      /\.(?:inner|outer)HTML\s*\+?=(?!=)/,
      new RegExp(`${NAMED('innerHTML|outerHTML').source}\\s*\\+?=(?!=)`),
      /\binsertAdjacentHTML\s*(?:\?\.\s*)?\(/,
      /\bdocument\s*\.\s*write(?:ln)?\s*(?:\?\.\s*)?\(/,
      /\bcreateContextualFragment\s*\(/,
      /\bsetHTMLUnsafe\s*\(/,
    ],
  },
  {
    rule: 'remote-code',
    severity: 'high',
    in: ['script', 'markup', 'style'],
    patterns: [
      REMOTE_SCRIPT,
      /\bimport\s*\(\s*["'`](?:https?:)?\/\//,
      // import x from "https://…", import "//…", export * from "https://…".
      /\b(?:from|import)\s*["'`](?:https?:)?\/\//,
      /\bimportScripts\s*\(/,
      /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i,
    ],
  },
  {
    rule: 'escape-attempt',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [
      /\bparent\s*\.\s*(?:document|location)\b/,
      /\btop\s*\.\s*(?:document|location)\b/,
      // The window that opened this one, not a variable of that name (review 2026-10-11).
      /\b(?:window|self|globalThis)\s*\.\s*opener\b/,
      /\bopener\s*\.\s*(?:document|location|postMessage)\b/,
      /\bframeElement\b/,
    ],
  },
  {
    rule: 'packed-code',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [/\b(?:eval|Function)\s*\(\s*atob\s*\(/],
  },
  {
    // Security audit 2026-10-16: a peer connection reaches out past connect-src 'none' (the CSP
    // webrtc directive is not known to every browser — Chromium 149 ignores it).
    rule: 'webrtc',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [/\b(?:webkit|moz)?RTC(?:PeerConnection|DataChannel)\b/],
  },
  {
    // Security audit 2026-10-16: a name looked up, or a server reached, ahead of time is a request
    // connect-src never sees — data can ride in the name.
    rule: 'prefetch-hint',
    severity: 'high',
    in: ['script', 'markup'],
    patterns: [
      /\bdns-prefetch\b/i,
      /\brel\s*=[\s"']*(?:preconnect|prefetch|prerender)\b/i,
      /\bsetAttribute\s*\(\s*["']rel["']\s*,[\s"']*(?:preconnect|prefetch|prerender)\b/i,
      /\brelList\s*\.\s*add\s*\(\s*["'](?:preconnect|prefetch|prerender)\b/i,
    ],
  },
  {
    rule: 'network',
    severity: 'medium',
    in: ['script', 'markup'],
    patterns: [
      // The global fetch, bare or through the global object; another object's fetch is its own.
      /\b(?<![.$]\s{0,20})fetch\s*\(|\b(?:window|self|globalThis)\s*\.\s*fetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bsendBeacon\b/,
    ],
  },
  {
    rule: 'inline-handler',
    severity: 'medium',
    in: ['markup'],
    patterns: [INLINE_HANDLER, /javascript\s*:/i],
  },
  {
    rule: 'workers',
    severity: 'medium',
    in: ['script', 'markup'],
    patterns: [/\bnew\s+(?:Shared)?Worker\s*\(/, /\bWebAssembly\s*\./],
  },
  {
    rule: 'storage',
    severity: 'low',
    in: ['script', 'markup'],
    patterns: [/\b(?:localStorage|sessionStorage|indexedDB)\b/, /\bdocument\s*\.\s*cookie\b/],
  },
]
/** Tags that may span lines: looked for in a markup file whole when no line had them. */
const ACROSS_LINES: Array<[rule: string, check: (text: string) => number]> = [
  ['remote-code', REMOTE_SCRIPT],
  ['inline-handler', INLINE_HANDLER],
]

const KINDS: Record<string, 'script' | 'markup' | 'style'> = {
  js: 'script',
  mjs: 'script',
  cjs: 'script',
  html: 'markup',
  htm: 'markup',
  svg: 'markup',
  css: 'style',
}
const ORDER: PluginScanSeverity[] = ['high', 'medium', 'low', 'info']
/** A line this long is minified (or generated) code: said once a file. */
const MINIFIED_LINE = 2000
/** About 10 KB of base64 in one string. */
const DATA_BLOB = 13654

/** Where the first run of DATA_BLOB base64 characters starts, counted once through (no regex). */
function blobAt(line: string): number {
  let run = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    const base64 =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2f
    run = base64 ? run + 1 : 0
    if (run === DATA_BLOB) return i - run + 1
  }
  return -1
}
/** At most this many findings of one rule in one file are listed (the counts are whole). */
const PER_RULE_FILE = 10
/** At most this many findings are kept in all, the most serious first (review 2026-10-11). */
const LISTED = 200
const EXCERPT = 160

/** What hides, reverses or breaks text: controls, direction marks, zero-width and tag characters. */
const hidden = (code: number) =>
  isSpoofingChar(code) ||
  (code >= 0x200b && code <= 0x200d) ||
  (code >= 0x2060 && code <= 0x2064) ||
  code === 0x180e ||
  code === 0xfeff ||
  (code >= 0xe0000 && code <= 0xe007f)

/** Where a finding is, as a reader sees it: a short line, nothing hidden, no half of a pair. */
function excerptOf(line: string, at: number): string {
  const start = Math.max(0, at - 40)
  return [...line.slice(start, start + EXCERPT)]
    .filter((c) => {
      const code = c.codePointAt(0)!
      return !hidden(code) && !(code >= 0xd800 && code <= 0xdfff)
    })
    .join('')
    .trim()
}

/**
 * The text a browser would run: UTF-16 when the file starts with its byte-order mark (a browser
 * obeys it over the declared charset), else UTF-8. `odd`: saved as UTF-16, or holding NUL bytes.
 */
function decode(data: Buffer): { text: string; odd: boolean } {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return { text: data.subarray(2).toString('utf16le'), odd: true }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff)
    return { text: Buffer.from(data.subarray(2)).swap16().toString('utf16le'), odd: true }
  const odd = data.includes(0)
  return { text: data.toString('utf8'), odd }
}

export function scanPlugin(
  files: ReadonlyMap<string, Buffer>,
  manifest: Pick<PluginManifest, 'permissions'>,
): PluginScan {
  const all: PluginScanFinding[] = []
  const counts: Record<PluginScanSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 }
  let truncated = false
  const add = (finding: PluginScanFinding, listed: Map<string, number>) => {
    counts[finding.severity]++
    const key = `${finding.rule}\u0000${finding.file}`
    const n = listed.get(key) ?? 0
    if (n >= PER_RULE_FILE) {
      truncated = true
      return
    }
    listed.set(key, n + 1)
    all.push(finding)
  }
  for (const [file, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const kind = KINDS[file.split('.').pop()?.toLowerCase() ?? '']
    if (!kind) continue
    const listed = new Map<string, number>()
    const { text: whole, odd } = decode(data)
    if (odd) add({ rule: 'unusual-encoding', severity: 'medium', file, line: 1, excerpt: '' }, listed)
    const lines = whole.split('\n')
    let minified = false
    lines.forEach((text, index) => {
      for (const rule of RULES) {
        if (!rule.in.includes(kind)) continue
        for (const pattern of rule.patterns) {
          const at = typeof pattern === 'function' ? pattern(text) : (pattern.exec(text)?.index ?? -1)
          if (at < 0) continue
          add(
            {
              rule: rule.rule,
              severity: rule.severity,
              file,
              line: index + 1,
              excerpt: excerptOf(text, at),
            },
            listed,
          )
          break
        }
      }
      if (kind === 'script' && !minified && text.length > MINIFIED_LINE) {
        minified = true
        add(
          { rule: 'minified', severity: 'info', file, line: index + 1, excerpt: excerptOf(text, 0) },
          listed,
        )
      }
      const blob = text.length >= DATA_BLOB ? blobAt(text) : -1
      if (blob >= 0)
        add(
          {
            rule: 'data-blob',
            severity: 'info',
            file,
            line: index + 1,
            excerpt: excerptOf(text, blob),
          },
          listed,
        )
    })
    if (kind === 'markup')
      for (const [rule, check] of ACROSS_LINES) {
        if (listed.has(`${rule}\u0000${file}`)) continue
        const at = check(whole)
        if (at < 0) continue
        const before = whole.slice(0, at)
        const line = before.split('\n').length
        add(
          {
            rule,
            severity: RULES.find((r) => r.rule === rule)!.severity,
            file,
            line,
            excerpt: excerptOf(whole.slice(at, at + EXCERPT).replace(/\s+/g, ' '), 0),
          },
          listed,
        )
      }
  }
  if (manifest.permissions.includes('documents:write')) {
    counts.medium++
    all.push({
      rule: 'write-permission',
      severity: 'medium',
      file: 'mongo-manager-plugin.json',
      line: 1,
      excerpt: 'documents:write',
    })
  }
  const sorted = all.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
  if (sorted.length > LISTED) truncated = true
  return { findings: sorted.slice(0, LISTED), counts, truncated }
}
