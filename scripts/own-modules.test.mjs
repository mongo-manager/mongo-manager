import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownModulesGuard } from './own-modules.mjs'

/** A bundle at <root>/app/dist/bundle.cjs, starting with the guard, and packages planted above it. */
function fixture(body, before = '') {
  const root = mkdtempSync(join(tmpdir(), 'mm-own-'))
  const dist = join(root, 'app', 'dist')
  mkdirSync(dist, { recursive: true })
  const plant = (name, code) => {
    mkdirSync(join(root, 'node_modules', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', name, 'index.js'), code)
  }
  plant('planted', "module.exports = 'planted'")
  // An add-on loaded by its own absolute folder, as the verified loader does, with a package of its own.
  mkdirSync(join(root, 'addon', 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'addon', 'node_modules', 'dep', 'index.js'), "module.exports = 'dep'")
  writeFileSync(join(root, 'addon', 'index.js'), "module.exports = 'addon+' + require('dep')")
  writeFileSync(join(dist, 'sibling.cjs'), "module.exports = 'sibling'")
  writeFileSync(
    join(dist, 'finder.cjs'),
    "module.exports = require('node:module').createRequire(require('node:path').join(__dirname, 'x.cjs'))('planted')",
  )
  mkdirSync(join(dist, 'sub'))
  writeFileSync(join(dist, 'sub', 'x.cjs'), "module.exports = require('planted')")
  // As the standalone binary runs the shell worker: its code compiled as a module with no file.
  writeFileSync(
    join(dist, 'compile.cjs'),
    [
      "const code = require('node:fs').readFileSync(require('node:path').join(__dirname, 'bundle.cjs'), 'utf8')",
      "new (require('node:module').Module)('mm-shell-worker.cjs')._compile(code.replace(/^#!.*/, ''), 'mm-shell-worker.cjs')",
    ].join('\n'),
  )
  writeFileSync(join(dist, 'bundle.cjs'), `#!/usr/bin/env node\n${before}${ownModulesGuard()}\n${body}\n`)
  const node = (file) => spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' })
  const run = () => node(join(dist, 'bundle.cjs'))
  const runCompiled = () => node(join(dist, 'compile.cjs'))
  return { root, dist, node, run, runCompiled }
}

const cases = {
  'a package by name, from node_modules above it': [
    "try { require('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  'a package by name through require.resolve': [
    "try { require.resolve('planted'); console.log('resolved') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  'a file of a package by name': [
    "try { require('planted/index.js'); console.log('loaded') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  'built-in modules, with and without node:': [
    "console.log(typeof require('fs').readFileSync, typeof require('node:path').join)",
    'function function',
  ],
  'a file beside it': ["console.log(require('./sibling.cjs'))", 'sibling'],
  'an add-on by its absolute folder, and what that add-on asks for itself': [
    "console.log(require(require('node:path').join(__dirname, '..', '..', 'addon')))",
    'addon+dep',
  ],
  // Second review 2026-10-20 (minor 2): nor through a require made for its own file, a dynamic
  // import, or Node's cache of what was found from its folder.
  'a package by name through a require made for its own file': [
    "try { require('node:module').createRequire(__filename)('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  'a package by name through import()': [
    "import('planted').then(() => console.log('loaded'), (e) => console.log(e.code))",
    'MODULE_NOT_FOUND',
  ],
  'a package by name another module of its folder asked for first': [
    "try { require('./finder.cjs') } catch {}\ntry { require('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  // Third review 2026-10-20 (minor 1, 3): a file: name is a package's name to require; and the
  // folders inside its own are its own too.
  'a package named as a file: URL': [
    "try { require('file:planted'); console.log('loaded') } catch (e) { console.log(/loads no package/.test(e.message)) }",
    'true',
  ],
  'a package by name from a folder inside its own': [
    "try { require('./sub/x.cjs'); console.log('loaded') } catch (e) { console.log(e.code) }",
    'MODULE_NOT_FOUND',
  ],
  // Fourth review 2026-10-20 (minor 1): a URL is no package's name to import().
  'its own file and data by URL through import()': [
    "const { pathToFileURL } = require('node:url')\n" +
      "import(pathToFileURL(require('node:path').join(__dirname, 'sibling.cjs')).href)\n" +
      "  .then((m) => import('data:text/javascript,export default 1').then((d) => console.log(m.default, d.default)))\n" +
      '  .catch((e) => console.log(e.code))',
    'sibling 1',
  ],
}

// Fourth review 2026-10-20 (minor 2): on Windows .\ names its own files.
test(
  'a bundle with the guard: a file beside it by .\\, on Windows',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, run } = fixture("console.log(require('.\\\\sibling.cjs'))")
    try {
      const r = run()
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), 'sibling')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

// Third review 2026-10-20 (minor 2): import() is refused where the bundle has no file of its own
// (the standalone binary's shell worker), and when it is started by a \\?\ path.
const both = [
  "try { require('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
  "import('planted').then(() => console.log('loaded'), (e) => console.log(e.code))",
].join('\n')

test('a bundle with the guard, compiled with no file of its own: require and import()', () => {
  // Fifth review 2026-10-20 (minor 1): nor through a require made for the name it was compiled as.
  const made = [
    "try { require('node:module').createRequire(require('node:url').pathToFileURL(__filename))('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
    "try { require('node:module').createRequire(require('node:path').resolve(__filename))('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
  ]
  const { root, runCompiled } = fixture([...made, both].join('\n'))
  try {
    const r = runCompiled()
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), Array(4).fill('MODULE_NOT_FOUND'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'a bundle with the guard, started by a \\\\?\\ path: require and import()',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, dist, node } = fixture(both)
    try {
      const r = node(`\\\\?\\${join(dist, 'bundle.cjs')}`)
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('a bundle with the guard, on a Node without the resolve hook: the lookup alone refuses them', () => {
  const { root, run } = fixture(
    [
      "try { require('./finder.cjs') } catch {}",
      "try { require('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
      "try { require('node:module').createRequire(__filename)('planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
      // Fourth review 2026-10-20 (minor 3): and from a folder inside its own.
      "try { require('./sub/x.cjs'); console.log('loaded') } catch (e) { console.log(e.code) }",
      "console.log(require(require('node:path').join(__dirname, '..', '..', 'addon')))",
    ].join('\n'),
    "delete require('node:module').registerHooks\n",
  )
  try {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), [
      'MODULE_NOT_FOUND',
      'MODULE_NOT_FOUND',
      'MODULE_NOT_FOUND',
      'addon+dep',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// On Windows .\ is relative; elsewhere it is part of a package's name, looked up like any other.
test(
  'a bundle with the guard: a package named with a backslash, outside Windows',
  { skip: process.platform === 'win32' },
  () => {
    const { root, run } = fixture(
      "try { require('.\\\\planted'); console.log('loaded') } catch (e) { console.log(e.code) }",
    )
    try {
      mkdirSync(join(root, 'node_modules', '.\\planted'), { recursive: true })
      writeFileSync(join(root, 'node_modules', '.\\planted', 'index.js'), "module.exports = 'planted'")
      assert.equal(run().stdout.trim(), 'MODULE_NOT_FOUND')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

for (const [name, [body, expected]] of Object.entries(cases)) {
  test(`a bundle with the guard: ${name}`, () => {
    const { root, run } = fixture(body)
    try {
      const r = run()
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('the guard says which package it would not look for', () => {
  const { root, run } = fixture("try { require('planted') } catch (e) { console.log(e.message) }")
  try {
    assert.match(run().stdout, /planted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
