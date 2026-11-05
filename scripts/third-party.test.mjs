// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergePackages,
  missingPackages,
  nodePackage,
  packageDirOf,
  packagesOf,
  renderNotices,
  thirdPartyList,
} from './third-party.mjs'

test('finds the package a bundled module came from, pnpm layout and scopes included', () => {
  assert.equal(
    packageDirOf('/r/node_modules/.pnpm/vue@3.5.0/node_modules/vue/dist/vue.js'),
    '/r/node_modules/.pnpm/vue@3.5.0/node_modules/vue',
  )
  assert.equal(
    packageDirOf('C:\\r\\node_modules\\@tanstack\\vue-query\\build\\index.js?x=1'),
    'C:/r/node_modules/@tanstack/vue-query',
  )
  assert.equal(packageDirOf('\0missing:kerberos'), null)
  assert.equal(packageDirOf('/r/packages/web/src/main.ts'), null)
})

test('lists each package once with its licence text, and renders them all', () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-third-'))
  try {
    const a = join(root, 'node_modules', 'alpha')
    const b = join(root, 'node_modules', '@scope', 'beta')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(
      join(a, 'package.json'),
      JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT' }),
    )
    writeFileSync(join(a, 'LICENSE'), 'MIT License\nCopyright Alpha')
    writeFileSync(
      join(b, 'package.json'),
      JSON.stringify({ name: '@scope/beta', version: '2.0.0', license: { type: 'ISC' } }),
    )
    const list = packagesOf([join(a, 'index.js'), join(a, 'other.js'), join(b, 'lib', 'x.js')])
    assert.deepEqual(
      list.map((p) => [p.name, p.version, p.license, p.texts.length]),
      [
        ['@scope/beta', '2.0.0', 'ISC', 0],
        ['alpha', '1.0.0', 'MIT', 1],
      ],
    )
    const text = renderNotices(mergePackages(list, list))
    assert.equal(text.match(/^alpha 1\.0\.0$/gm)?.length, 1)
    assert.match(text, /Copyright Alpha/)
    assert.match(text, /@scope\/beta 2\.0\.0\nLicense: ISC/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Review of the ops fixes (I4): the standalone binaries and the image are Node.js with our code, so
// Node's own licence (V8, OpenSSL, ICU, libuv and the rest in it) is among the notices.
test('names Node.js with its licence, found beside the program that runs the build', () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-node-'))
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'LICENSE'), 'Node.js is licensed for use as follows: MIT')
    const entry = nodePackage(join(root, 'bin', 'node'), 'v24.1.0')
    assert.deepEqual(
      [entry.name, entry.version, entry.texts[0]],
      ['node', '24.1.0', 'Node.js is licensed for use as follows: MIT'],
    )
    // Without the file, it is still named, and where its licence is.
    const empty = join(root, 'empty', 'nowhere')
    mkdirSync(empty, { recursive: true })
    const bare = nodePackage(join(empty, 'node.exe'), 'v24.1.0')
    assert.equal(bare.texts[0], 'See https://github.com/nodejs/node/blob/v24.1.0/LICENSE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// W2 (2026-10-16): data bundled from outside node_modules (the Schema map's Natural Earth outline)
// is named in the notices when, and only when, the build read it.
test('lists bundled data that is no package, when the build read its file', () => {
  const entry = {
    name: 'Natural Earth',
    version: '5.1.2',
    license: 'Public Domain',
    texts: ['Made with Natural Earth.'],
  }
  const run = (ids) => {
    const emitted = []
    const plugin = thirdPartyList([], [{ file: 'src/schema/geo/land-110m.json', entry }])
    plugin.generateBundle.call({ getModuleIds: () => ids, emitFile: (f) => emitted.push(f) }, {}, {})
    return JSON.parse(emitted[0].source)
  }
  const read = run(['C:\\r\\packages\\web\\src\\schema\\geo\\land-110m.json'])
  assert.deepEqual(read, [entry])
  assert.deepEqual(run(['/r/packages/web/src/main.ts']), [])
  assert.match(renderNotices(read), /Natural Earth 5\.1\.2\nLicense: Public Domain/)
})

test('says which known packages a notices list lost', () => {
  const list = [{ name: 'vue', version: '3', license: 'MIT', texts: [] }]
  assert.deepEqual(missingPackages(list, ['vue', 'tailwindcss']), ['tailwindcss'])
})
