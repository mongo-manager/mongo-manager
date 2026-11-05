#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User request 2026-11-03: every source file of Mongo Manager starts with its license notice, the
 * SPDX identifier and the copyright line NOTICE's section 7(b) term keeps in the code and every copy.
 *
 *   node scripts/license-headers.mjs          lists the files without it (exit 1), as CI does
 *   node scripts/license-headers.mjs --write  adds it where it is missing
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPDX = 'SPDX-License-Identifier: AGPL-3.0-only'
export const COPYRIGHT = 'Copyright (C) 2026 Gokhan OZGEZER'

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue|css)$/
/** The plugin starter is MIT (NOTICE): a plugin made from it may take any license. */
const OUTSIDE = [/^packages\/plugins\/starter\//]

export const covered = (path) => SOURCE.test(path) && !OUTSIDE.some((re) => re.test(path))

/** The notice as a file of its kind writes a comment. */
export function headerOf(path) {
  if (path.endsWith('.vue')) return `<!-- ${SPDX} -->\n<!-- ${COPYRIGHT} -->\n`
  if (path.endsWith('.css')) return `/* ${SPDX} */\n/* ${COPYRIGHT} */\n`
  return `// ${SPDX}\n// ${COPYRIGHT}\n`
}

/** A script's `#!` line stays first: the notice comes right after it. */
const split = (text) => {
  if (!text.startsWith('#!')) return ['', text]
  const end = text.indexOf('\n')
  return end < 0 ? [`${text}\n`, ''] : [text.slice(0, end + 1), text.slice(end + 1)]
}

export const hasHeader = (path, text) => split(text)[1].startsWith(headerOf(path))

export function withHeader(path, text) {
  if (hasHeader(path, text)) return text
  const [shebang, rest] = split(text)
  return `${shebang}${headerOf(path)}${rest}`
}

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

function main() {
  const write = process.argv.includes('--write')
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && covered(p))
  const missing = []
  for (const path of files) {
    const file = join(ROOT, path)
    const text = readFileSync(file, 'utf8')
    if (hasHeader(path, text)) continue
    if (write) writeFileSync(file, withHeader(path, text))
    else missing.push(path)
  }
  if (!missing.length) return
  console.error(`${missing.length} source file(s) do not start with the license notice:`)
  for (const path of missing) console.error(`  ${path}`)
  console.error('Run node scripts/license-headers.mjs --write (see NOTICE).')
  process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
