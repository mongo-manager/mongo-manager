// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findForbidden, scan } from './check-forbidden.mjs'

const rules = (text, file = 'a.ts') => findForbidden(text, file).map((h) => h.rule)

test('flags eval calls', () => {
  assert.deepEqual(rules('const x = eval("1")'), ['eval'])
})

test('flags the Function constructor in both forms', () => {
  assert.deepEqual(rules('new Function("return 1")'), ['new-function'])
  assert.deepEqual(rules('Function("x")()'), ['new-function'])
})

// Plan 1a deferred minor: code generation reached indirectly passed the gate.
test('flags eval and the Function constructor reached indirectly', () => {
  for (const s of [
    '(0, eval)("1")',
    'const f = (1, eval)',
    'globalThis["eval"]("1")',
    "self['Function']('x')",
    // Review of the deferred fixes (M9).
    'eval?.("x")',
    '[eval][0]("x")',
    'const e = eval',
    'Reflect.apply(eval, null, ["x"])',
    'Reflect.construct(Function, ["x"])',
    'new (Function)("x")',
    'Function.prototype.constructor("x")',
    'Function.call(null, "x")',
    '[].constructor.constructor("x")()',
    '(async () => {}).constructor("x")',
    'x.constructor("return this")',
  ]) {
    assert.ok(rules(s).length > 0, s)
  }
  for (const s of ['await import(`vm`)', "createRequire(import.meta.url)('node:vm')"]) {
    assert.deepEqual(rules(s), ['vm'], s)
  }
  // Still not code generation: a class's own constructor, a type, a word in a comment or string.
  assert.deepEqual(
    rules('constructor(private x: number) {}; type F = Function; const evaluate = 1; super(x); "eval"'),
    [],
  )
  for (const s of [
    'globalThis.Function("x")()',
    'window.Function("x")',
    'global . Function("x")',
    'self.Function("x")',
  ]) {
    assert.deepEqual(rules(s), ['new-function'], s)
  }
  for (const s of ['setTimeout("alert(1)", 1)', 'setInterval(`x()`, 5)']) {
    assert.deepEqual(rules(s), ['string-timer'], s)
  }
  assert.deepEqual(rules('setTimeout(() => x(), 1); obj.Function(1); retrieval(1)'), [])
})

test('scans the plugins’ sources too', () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-forbidden-'))
  try {
    mkdirSync(join(root, 'packages', 'plugins', 'demo', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'plugins', 'demo', 'src', 'a.ts'), 'eval("1")\n')
    mkdirSync(join(root, 'packages', 'plugins', 'demo', 'node_modules', 'x', 'src'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'plugins', 'demo', 'node_modules', 'x', 'src', 'b.ts'),
      'eval("1")\n',
    )
    const hits = scan(root).map((h) => `${h.file.split('\\').join('/')}:${h.rule}`)
    assert.deepEqual(hits, ['packages/plugins/demo/src/a.ts:eval'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('flags vm imports in every syntax', () => {
  for (const s of ["import vm from 'node:vm'", "const vm = require('vm')", 'await import("vm")']) {
    assert.deepEqual(rules(s), ['vm'], s)
  }
})

test('flags v-html', () => {
  assert.deepEqual(rules('<div v-html="x"></div>', 'a.vue'), ['v-html'])
})

// Short names review 7: a raw unseen character in source is refused; the same as a \u escape is not.
test('flags raw bidi controls and other unseen characters, not their escapes', () => {
  for (const c of ['\u202E', '\u2066', '\u200B', '\u200D', '\u2028', '\u3164', '\uFEFF', '\u00AD']) {
    assert.deepEqual(rules(`const s = "a${c}b"`), ['unseen-character'], `U+${c.codePointAt(0).toString(16)}`)
  }
  assert.deepEqual(rules('const s = "a\\u202Eb"; const r = /[\\u2066-\\u2069]/'), [])
  assert.deepEqual(rules('const s = "café — “quoted” ✓ 😀 ğüşıöç"'), [])
  // Review 8 (M-8): the rest of the default-ignorable and format characters, tags (astral) too;
  // the variation selectors of an emoji are not refused.
  for (const c of ['\u034F', '\u17B4', '\u180B', '\u206A', '\uFFF9', '\u2800', '\u{E0041}', '\u{1D173}']) {
    assert.deepEqual(rules(`const s = "a${c}b"`), ['unseen-character'], `U+${c.codePointAt(0).toString(16)}`)
  }
  assert.deepEqual(rules('const s = "\u2764\uFE0F \u270C\uFE0E 1\uFE0F\u20E3"'), [])
  // Review 11 (M-6): a run of selectors, or one after a plain letter, spells hidden text.
  assert.deepEqual(rules('const s = "\u2764\uFE0F\uFE0F\uFE0E"'), ['unseen-character'])
  assert.deepEqual(rules('const s = "a\uFE0F"'), ['unseen-character'])
  // Review 12 (M-8): a digit's selector only before the keycap mark; none after an unassigned point.
  assert.deepEqual(rules('const s = "v1\uFE0F.2\uFE0E"'), ['unseen-character'])
  assert.deepEqual(rules('const s = "\u{1FC00}\uFE0F"'), ['unseen-character'])
  // Review 12 (M-9): control characters, and a carriage return that ends a line on its own.
  for (const c of ['\x08', '\x1b', '\x7f', '\u0085', '\r'])
    assert.deepEqual(
      rules(`const s = 1; ${c}// a comment`),
      ['unseen-character'],
      `U+${c.codePointAt(0).toString(16)}`,
    )
  assert.deepEqual(rules('const s = "a\tb"\r\nconst t = 1'), [])
})

// Review 8 (M-9): the unseen-character rule reaches tests, scripts and JSON; the other rules do not.
test('scans tests, scripts and JSON for unseen characters only', () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-forbidden-'))
  try {
    mkdirSync(join(root, 'packages', 'web', 'src', 'i18n'), { recursive: true })
    mkdirSync(join(root, 'packages', 'web', 'test'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'packages', 'web', 'src', 'i18n', 'en.json'), '{ "a": "x\u202Ey" }')
    writeFileSync(join(root, 'packages', 'web', 'test', 'a.test.ts'), 'eval("1"); const s = "\u2066"')
    writeFileSync(join(root, 'scripts', 'b.mjs'), 'const s = "\uFEFF"')
    // Review 9 (M-4): a package's own scripts and configs, HTML, .mts, workflows and the top level.
    mkdirSync(join(root, 'packages', 'cli', 'scripts'), { recursive: true })
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(root, 'backend', 'data'), { recursive: true })
    mkdirSync(join(root, 'packages', 'web', 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'packages', 'cli', 'scripts', 'build.mjs'), 'const s = "\u2066"')
    writeFileSync(join(root, 'packages', 'web', 'vite.config.ts'), 'const s = "\u2066"')
    writeFileSync(join(root, 'packages', 'web', 'index.html'), '<p>\u2066</p>')
    writeFileSync(join(root, 'packages', 'web', 'files.d.mts'), 'const s = "\u2066"')
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'run: echo "\u2066"')
    writeFileSync(join(root, 'eslint.config.js'), 'const s = "\u2066"')
    // Not read: the server's data, and what is not ours.
    writeFileSync(join(root, 'backend', 'data', 'users.json'), '{ "a": "\u2066" }')
    writeFileSync(join(root, 'packages', 'web', 'node_modules', 'x', 'i.js'), 'const s = "\u2066"')
    const hits = scan(root)
      .map((h) => `${h.file.split('\\').join('/')}:${h.rule}`)
      .sort()
    assert.deepEqual(hits, [
      '.github/workflows/ci.yml:unseen-character',
      'eslint.config.js:unseen-character',
      'packages/cli/scripts/build.mjs:unseen-character',
      'packages/web/files.d.mts:unseen-character',
      'packages/web/index.html:unseen-character',
      'packages/web/src/i18n/en.json:unseen-character',
      'packages/web/test/a.test.ts:unseen-character',
      'packages/web/vite.config.ts:unseen-character',
      'scripts/b.mjs:unseen-character',
    ])
    // Review 10 (M-2): a dangling link does not hide the rest of its folder.
    symlinkSync(join(root, 'nowhere'), join(root, 'packages', 'web', 'a-dangling'), 'junction')
    writeFileSync(join(root, 'packages', 'web', 'test', 'z.test.ts'), 'const s = "\u2066"')
    assert.ok(scan(root).some((h) => h.file.split('\\').join('/') === 'packages/web/test/z.test.ts'))
    // Review 10 (M-3): styles, unit files and Dockerfiles; not a file that is not text.
    writeFileSync(join(root, 'packages', 'web', 'a.css'), 'a { content: "\u2066" }')
    writeFileSync(join(root, 'Dockerfile'), 'RUN echo "\u2066"')
    writeFileSync(join(root, 'packages', 'web', 'b.png'), Buffer.from([0x89, 0x50, 0, 0, 0xe2, 0x81, 0xa6]))
    const now = scan(root).map((h) => h.file.split('\\').join('/'))
    assert.ok(now.includes('packages/web/a.css') && now.includes('Dockerfile'))
    assert.ok(!now.includes('packages/web/b.png'))
    // Review 11 (I-1): a NUL in a known text file does not hide it; it is reported itself.
    writeFileSync(join(root, 'packages', 'web', 'test', 'nul.test.ts'), '// \0\nconst s = "\u202E"')
    const withNul = scan(root).filter((h) => h.file.split('\\').join('/') === 'packages/web/test/nul.test.ts')
    assert.equal(withNul.length, 2)
    // A UTF-16 script is read as one.
    writeFileSync(
      join(root, 'scripts', 'w.ps1'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('$s = "\u2066"', 'utf16le')]),
    )
    // In a git checkout, what git ignores is not read.
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'packages/cli/scripts/\n')
    const kept = scan(root).map((h) => h.file.split('\\').join('/'))
    assert.ok(!kept.includes('packages/cli/scripts/build.mjs'))
    assert.ok(kept.includes('packages/web/index.html'))
    // In a checkout, every text file (a unit file, a Caddyfile), never backend/ nor docs/.
    mkdirSync(join(root, 'deploy'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'deploy', 'mm.service'), 'ExecStart=/x "\u2066"')
    writeFileSync(join(root, 'deploy', 'Caddyfile'), 'x { "\u2066" }')
    writeFileSync(join(root, 'docs', 'a.md'), '\u2066')
    const checked = scan(root).map((h) => h.file.split('\\').join('/'))
    assert.ok(checked.includes('deploy/mm.service') && checked.includes('deploy/Caddyfile'))
    assert.ok(!checked.some((f) => f.startsWith('docs/') || f.startsWith('backend/')))
    // A file that is not text (a NUL in its head) is not read, whatever its name.
    assert.ok(!checked.includes('packages/web/b.png'))
    // Read as UTF-16: its unseen character is found, not a NUL of its encoding.
    assert.deepEqual(
      scan(root)
        .filter((h) => h.file.split('\\').join('/') === 'scripts/w.ps1')
        .map((h) => h.message.startsWith('An unseen character')),
      [true],
    )
    // Review 12 (M-5): a binary of another kind is not read, whatever its size or first bytes.
    writeFileSync(
      join(root, 'scripts', 'fixture.bin'),
      Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x00, 0x66, 0x20]),
    )
    writeFileSync(join(root, 'scripts', 'huge.wasm'), Buffer.alloc(33 * 1024 * 1024, 0))
    // Review 12 (M-4): an odd-length UTF-16 BE file is read, not a crash.
    writeFileSync(join(root, 'scripts', 'odd.json'), Buffer.from([0xfe, 0xff, 0x20, 0x66, 0x41]))
    const binaries = scan(root).map((h) => h.file.split('\\').join('/'))
    assert.ok(!binaries.includes('scripts/fixture.bin') && !binaries.includes('scripts/huge.wasm'))
    assert.ok(binaries.includes('scripts/odd.json'))
    rmSync(join(root, 'scripts', 'huge.wasm'))
    // Review 12 (M-7, M-6): a NUL in src is reported too, with the way out.
    writeFileSync(join(root, 'packages', 'web', 'src', 'nul.ts'), 'const s = 1 // \0')
    const nul = scan(root).find((h) => h.file.split('\\').join('/') === 'packages/web/src/nul.ts')
    assert.ok(nul && /binary extension/.test(nul.message))
    rmSync(join(root, 'packages', 'web', 'src', 'nul.ts'))
    // Review 11 (M-5): a file too large to read whole is reported, never passed unseen.
    writeFileSync(join(root, 'scripts', 'big.mjs'), Buffer.alloc(33 * 1024 * 1024, 0x61))
    assert.ok(scan(root).some((h) => h.file.endsWith('big.mjs') && h.message.startsWith('Too large')))
    rmSync(join(root, 'scripts', 'big.mjs'))
    // Review 13 (M-1): instructions an agent reads — markdown, with a NUL or as UTF-16 — are read.
    writeFileSync(join(root, 'CLAUDE.md'), '# hi \0 \u{E0041}')
    writeFileSync(
      join(root, 'AGENTS.md'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\u2066', 'utf16le')]),
    )
    writeFileSync(
      join(root, 'notes.unknown'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\u2066', 'utf16le')]),
    )
    const agents = scan(root).map((h) => h.file.split('\\').join('/'))
    assert.ok(
      agents.includes('CLAUDE.md') && agents.includes('AGENTS.md') && agents.includes('notes.unknown'),
    )
    // Review 11 (M-5): a link git keeps is not followed.
    if (process.platform !== 'win32') {
      writeFileSync(join(root, 'outside.txt'), 'x')
      symlinkSync(join(root, 'outside.txt'), join(root, 'scripts', 'link.mjs'))
      assert.ok(!scan(root).some((h) => h.file.endsWith('link.mjs')))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ignores lookalikes', () => {
  assert.deepEqual(rules('isFunction(x); obj.eval_(1); retrieval(1); medieval (x); obj.Function(1)'), [])
})

test('reports 1-based line numbers', () => {
  const [hit] = findForbidden('ok\nok\neval(1)', 'src/x.ts')
  assert.equal(hit.line, 3)
  assert.equal(hit.file, 'src/x.ts')
})

test('exempts vm only in the shell worker runtime, nothing else', () => {
  const line = "import vm from 'node:vm'"
  assert.deepEqual(rules(line, 'packages/server/src/shell/worker/runtime.ts'), [])
  // The exemption is file- and rule-specific: vm elsewhere, or new Function in runtime, still flags.
  assert.deepEqual(rules(line, 'packages/server/src/shell/other.ts'), ['vm'])
  assert.deepEqual(rules('new Function("x")', 'packages/server/src/shell/worker/runtime.ts'), [
    'new-function',
  ])
})

test('exempts the sandbox self-check Function only in the worker entry', () => {
  assert.deepEqual(rules('new Function("return 1")()', 'packages/server/src/shell/worker/entry.ts'), [])
  assert.deepEqual(rules("import vm from 'node:vm'", 'packages/server/src/shell/worker/entry.ts'), ['vm'])
})

test('skips generated build artifacts', () => {
  assert.deepEqual(
    rules('eval(x); new Function(y)', 'packages/server/src/shell/worker/contextless-eval.generated.cjs'),
    [],
  )
})

test('destinations may not open their own HTTP requests (phase 3d-3b)', () => {
  const file = 'packages/server/src/backup/destinations/s3.ts'
  assert.deepEqual(rules("import https from 'node:https'", file), ['raw-http'])
  assert.deepEqual(rules('await fetch(url)', file), ['raw-http'])
  assert.deepEqual(rules('await fetch(url)', 'packages/web/src/api/client.ts'), [])
})

// Phase 3d-3b final review B28: every way to reach the network outside net/egress.ts.
test('raw-http cannot be bypassed by another module name or import form', () => {
  const file = 'packages/server/src/backup/destinations/webdav.ts'
  for (const line of [
    "import https from 'https'",
    "import * as http from 'http'",
    'import http from "node:http"',
    "const https = require('node:https')",
    "const http = require( 'http' )",
    "const { request } = await import('node:https')",
    "const h = await import('https')",
    "import tls from 'node:tls'",
    "import { connect } from 'node:net'",
    "import { connect } from 'net'",
    "import http2 from 'node:http2'",
    "import { request } from 'undici'",
    "const { fetch: f } = require('undici')",
    "import dgram from 'node:dgram'",
    "export { request } from 'node:https'",
    "import 'node:https'",
  ])
    assert.deepEqual(rules(line, file), ['raw-http'], line)
  // Names that only look alike are fine.
  for (const line of [
    "import { netOf } from '../net/cidr'",
    "if (!/[?&](tls|ssl)=/i.test(base)) params.push(['tls', 'true'])",
    "import { createEgress } from '../../net/egress'",
    'const job = fetchKind(deps)',
  ])
    assert.deepEqual(rules(line, file), [], line)
})

test('raw-http covers the send and fetch jobs and the destination routes; egress.ts is the one place allowed', () => {
  const line = "import https from 'node:https'"
  for (const file of [
    'packages/server/src/backup/send-job.ts',
    'packages/server/src/backup/fetch-job.ts',
    'packages/server/src/backup/store.ts',
    'packages/server/src/routes/destinations.ts',
    'packages\\server\\src\\backup\\destinations\\s3.ts',
  ])
    assert.deepEqual(rules(line, file), ['raw-http'], file)
  assert.deepEqual(rules(line, 'packages/server/src/net/egress.ts'), [])
})
