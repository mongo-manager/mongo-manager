// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../src/i18n/locales/en.json'

type Tree = { [key: string]: string | Tree }
const keys = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  )
const src = join(process.cwd(), 'src')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(vue|ts)$/.test(e.name) ? [join(dir, e.name)] : [],
  )

/**
 * Reviewer C Minor 13: the screens UI redesign R1 rewrote use every message they define. Keys built
 * at run time (`documents.columns.${…}`) are found by their prefix.
 */
describe('messages of the rewritten screens', () => {
  const code = files(src)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  const dynamic = [...code.matchAll(/`([a-zA-Z._]+[._])\$\{/g)].map((m) => m[1]!)
  const AREAS = [
    'documents.',
    'aggregation.ask.',
    'aggregation.run.',
    'query.',
    'ai.sheet.',
    'ai.warning.',
    // W1 (completion §2): the data explorer's own messages.
    'explorer.',
  ]

  it('are all used', () => {
    const unused = keys(en as Tree)
      .filter((k) => AREAS.some((a) => k.startsWith(a)))
      .filter((k) => !dynamic.some((d) => k.startsWith(d)))
      .filter((k) => !code.includes(`'${k}'`) && !code.includes(`"${k}"`) && !code.includes(`\`${k}\``))
    expect(unused).toEqual([])
  })
})
