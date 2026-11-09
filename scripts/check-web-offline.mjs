// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// The built web app must load nothing from another origin (spec §3.6): no CDN script, font or
// stylesheet, no preconnect or prefetch hints, no absolute URL in HTML attributes or CSS. The
// browser test catches requests; this also catches hints that never become request events.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// An absolute (scheme or protocol-relative) URL.
const ABSOLUTE = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i
const HTML_ATTRS =
  /\s(?:src|href|srcset|poster|data|action|formaction|content|imagesrcset)\s*=\s*(["'])(.*?)\1/gis
const CSS_URLS = /(?:url\(\s*(["']?)(.*?)\1\s*\)|@import\s+(["'])(.*?)\3)/gis

/** Problems in one HTML, SVG or CSS file, as `file: url`. */
export function offlineProblems(text, file) {
  const problems = []
  const flag = (url) => problems.push(`${file}: loads ${url.trim()} from another origin`)
  if (/\.webmanifest$/i.test(file)) {
    // Every string of the manifest (start_url, scope, icon sources) must be relative.
    const walk = (v) => {
      if (typeof v === 'string') {
        if (ABSOLUTE.test(v)) flag(v)
      } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(JSON.parse(text))
    return problems
  }
  if (/\.css$/i.test(file)) {
    for (const m of text.matchAll(CSS_URLS)) {
      const url = m[2] ?? m[4]
      if (ABSOLUTE.test(url)) flag(url)
    }
    return problems
  }
  for (const m of text.matchAll(HTML_ATTRS)) {
    // <meta http-equiv=refresh content="0; url=…">: only the URL part matters.
    const url = m[2].replace(/^\s*\d+\s*;\s*url\s*=\s*/i, '')
    if (url.split(',').some((part) => ABSOLUTE.test(part))) flag(url)
  }
  return problems
}

if (import.meta.main) {
  const root = join(import.meta.dirname, '..', 'packages', 'web', 'dist')
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(html|svg|css|webmanifest)$/i.test(e.name))
    .map((e) => join(e.parentPath, e.name))
  if (!files.some((f) => f.endsWith('index.html'))) {
    console.error('packages/web/dist has no build: run "pnpm build" first')
    process.exit(1)
  }
  const problems = files.flatMap((f) => offlineProblems(readFileSync(f, 'utf8'), relative(root, f)))
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
  console.log(`web offline: ${files.length} HTML/SVG/CSS/manifest files load nothing from another origin`)
}
