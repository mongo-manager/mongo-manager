import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Review 2026-10-11 (I5): the plugin starter's packer never deletes the plugin it packs, and a
// `~` it is given is the home folder in every shell.
const STARTER = join(import.meta.dirname, '..', 'packages', 'plugins', 'starter')

function copy() {
  const root = mkdtempSync(join(tmpdir(), 'mm-starter-'))
  const plugin = join(root, 'hello-documents')
  cpSync(STARTER, plugin, { recursive: true, filter: (p) => !p.endsWith('.tgz') })
  return { root, plugin }
}
const pack = (plugin, args, env = {}, flags = []) =>
  spawnSync(process.execPath, [...flags, join(plugin, 'scripts', 'pack.mjs'), ...args], {
    cwd: plugin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

test('packs the starter into <id>-<version>.tgz with its digest', () => {
  const { root, plugin } = copy()
  try {
    const out = pack(plugin, [])
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /digest \(sha256\): [0-9a-f]{64}/)
    assert.ok(existsSync(join(plugin, 'hello-documents-0.1.0.tgz')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses to copy a plugin onto itself or into its own folder, deleting nothing', () => {
  const { root, plugin } = copy()
  try {
    const before = readdirSync(plugin).sort()
    // The plugin's folder is <plugins>/<id> already: copying there would replace it.
    for (const target of [root, plugin, '.', join(plugin, 'sub')]) {
      const out = pack(plugin, ['--folder', target])
      assert.notEqual(out.status, 0, target)
      assert.match(out.stderr, /the plugin's own folder/, target)
      assert.deepEqual(
        readdirSync(plugin)
          .filter((n) => !n.endsWith('.tgz'))
          .sort(),
        before.filter((n) => !n.endsWith('.tgz')),
        target,
      )
      assert.ok(existsSync(join(plugin, 'scripts', 'pack.mjs')), target)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Review 2026-10-18 (important): a plugins folder that is a link to the folder holding the plugin is
// that folder: copying there deleted every file of the plugin that is not packed.
test("refuses a plugins folder that leads to the plugin's own through a link, deleting nothing", () => {
  const { root, plugin } = copy()
  const home = mkdtempSync(join(tmpdir(), 'mm-home-'))
  try {
    const link = join(home, 'plugins')
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    const before = readdirSync(plugin).sort()
    const out = pack(plugin, ['--folder', link])
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /the plugin's own folder/)
    assert.deepEqual(
      readdirSync(plugin)
        .filter((n) => !n.endsWith('.tgz'))
        .sort(),
      before.filter((n) => !n.endsWith('.tgz')),
    )
    assert.ok(existsSync(join(plugin, 'scripts', 'pack.mjs')))
    assert.ok(existsSync(join(plugin, 'CLAUDE.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// Review 2026-10-18 (important 1): a folder that holds more than a copy (the plugin by another name,
// or another clone of it with its scripts) is never replaced, whatever path leads there.
test("replaces a copy it made, and refuses a folder holding the plugin's scripts, deleting nothing", () => {
  const { root, plugin } = copy()
  const other = copy()
  const plugins = mkdtempSync(join(tmpdir(), 'mm-plugins-'))
  try {
    for (let i = 0; i < 2; i++) {
      const out = pack(plugin, ['--folder', plugins])
      assert.equal(out.status, 0, out.stderr)
      // Swapped in, nothing left beside it; a Finder .DS_Store is no one's work.
      assert.deepEqual(readdirSync(plugins), ['hello-documents'])
      writeFileSync(join(plugins, 'hello-documents', '.DS_Store'), '')
    }
    rmSync(join(plugins, 'hello-documents'), { recursive: true })
    cpSync(other.plugin, join(plugins, 'hello-documents'), { recursive: true })
    const before = readdirSync(join(plugins, 'hello-documents')).sort()
    const out = pack(plugin, ['--folder', plugins])
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /which the script never copies/)
    assert.deepEqual(readdirSync(join(plugins, 'hello-documents')).sort(), before)
    assert.ok(existsSync(join(plugins, 'hello-documents', 'scripts', 'pack.mjs')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(other.root, { recursive: true, force: true })
    rmSync(plugins, { recursive: true, force: true })
  }
})

// Review 2026-10-18 (minor 3): ~ alone and ~\ are the home folder too; a ~ a shell left, or a
// backslash where it is no separator, is refused.
test('reads ~ and ~\\ alone as the home folder, and refuses a ~ that is not it', () => {
  const { root, plugin } = copy()
  const home = mkdtempSync(join(tmpdir(), 'mm-home-'))
  try {
    for (const given of ['~', '~\\']) {
      rmSync(join(home, 'hello-documents'), { recursive: true, force: true })
      const out = pack(plugin, ['--folder', given], { HOME: home, USERPROFILE: home })
      assert.equal(out.status, 0, out.stderr)
      assert.ok(existsSync(join(home, 'hello-documents', 'mongo-manager-plugin.json')), given)
      assert.deepEqual(readdirSync(home), ['hello-documents'], given)
    }
    const refused = [
      '~plugins',
      '~user/plugins',
      ...(process.platform === 'win32' ? ['~/plugins.', '~/plugins '] : ['~\\a\\plugins', '~/a\\plugins']),
    ]
    for (const given of refused) {
      const out = pack(plugin, ['--folder', given], { HOME: home, USERPROFILE: home })
      assert.notEqual(out.status, 0, given)
      assert.match(out.stderr, /home folder|put \/ between folders|end in a dot or a space/, given)
      assert.ok(!existsSync(join(plugin, given)), given)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('reads ~ as the home folder, in every shell', () => {
  const { root, plugin } = copy()
  const home = mkdtempSync(join(tmpdir(), 'mm-home-'))
  try {
    mkdirSync(join(home, 'plugins'))
    for (const given of ['~/plugins', '~\\plugins']) {
      rmSync(join(home, 'plugins', 'hello-documents'), { recursive: true, force: true })
      const out = pack(plugin, ['--folder', given], { HOME: home, USERPROFILE: home })
      assert.equal(out.status, 0, out.stderr)
      assert.ok(existsSync(join(home, 'plugins', 'hello-documents', 'mongo-manager-plugin.json')), given)
      assert.ok(!existsSync(join(plugin, '~')), given)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// Review of f8293686 (minor 7): renames the packer makes, logged, and one step of the swap made to
// fail or something put in the copy set aside, as a concurrent change would.
const HOOK = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
const rename = fs.renameSync
fs.renameSync = function (from, to) {
  fs.appendFileSync(process.env.HOOK_LOG, basename(from) + ' ' + basename(to) + '\\n')
  const mode = process.env.HOOK ?? ''
  const fails = (prefix) => mode.includes(prefix) && basename(to).startsWith(prefix)
  if (mode === 'fail-swap' && /^\\.pack-hello/.test(basename(from)))
    throw Object.assign(new Error('EPERM: hooked'), { code: 'EPERM' })
  if (fails('.pack-old-') || fails('.pack-kept-')) throw Object.assign(new Error('EXDEV: hooked'), { code: 'EXDEV' })
  const done = rename.call(this, from, to)
  if (mode === 'occupy' && basename(to).startsWith('.old-')) {
    fs.mkdirSync(from)
    fs.writeFileSync(join(from, 'theirs.txt'), 'theirs')
  }
  if (mode.startsWith('clone') && basename(to).startsWith('.old-')) {
    fs.mkdirSync(join(to, '.git'))
    fs.writeFileSync(join(to, '.git', 'HEAD'), 'history')
  }
  return done
}
syncBuiltinESMExports()
`

function hooked(t) {
  const { root, plugin } = copy()
  const plugins = mkdtempSync(join(tmpdir(), 'mm-plugins-'))
  const hook = join(root, 'hook.mjs')
  const log = join(root, 'renames.log')
  writeFileSync(hook, HOOK)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(plugins, { recursive: true, force: true })
  })
  const run = (mode = '') => {
    writeFileSync(log, '')
    const out = pack(plugin, ['--folder', plugins], { HOOK: mode, HOOK_LOG: log }, [
      '--import',
      pathToFileURL(hook).href,
    ])
    return { ...out, renames: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
  }
  return { plugins, run }
}

test("writes a copy beside the folder under a name the server's scan leaves alone, then swaps it in", (t) => {
  const { plugins, run } = hooked(t)
  for (let i = 0; i < 2; i++) {
    const out = run()
    assert.equal(out.status, 0, out.stderr)
    assert.ok(
      out.renames.some((r) => /^\.pack-hello-documents\.[0-9a-f-]+ hello-documents$/.test(r)),
      out.renames.join('; '),
    )
    assert.ok(!out.renames.some((r) => r.includes('.staging-')))
  }
  assert.deepEqual(readdirSync(plugins), ['hello-documents'])
})

test('puts the old copy back when the swap stops, and leaves nothing beside it', (t) => {
  const { plugins, run } = hooked(t)
  assert.equal(run().status, 0)
  const before = readdirSync(join(plugins, 'hello-documents')).sort()
  const out = run('fail-swap')
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /the copy stopped \(EPERM\); the folder was left as it was;/)
  assert.deepEqual(readdirSync(join(plugins, 'hello-documents')).sort(), before)
  assert.deepEqual(readdirSync(plugins), ['hello-documents'])
})

test("keeps an old copy something was put in after it was judged, where the server's scan leaves it", (t) => {
  const { plugins, run } = hooked(t)
  assert.equal(run().status, 0)
  const out = run('clone')
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stderr, /the last copy is kept, not deleted, at .*\.pack-kept-hello-documents\./)
  const kept = readdirSync(plugins).filter((n) => n.startsWith('.pack-kept-hello-documents.'))
  assert.equal(kept.length, 1)
  assert.equal(readFileSync(join(plugins, kept[0], '.git', 'HEAD'), 'utf8'), 'history')
  assert.ok(!readdirSync(plugins).some((n) => n.startsWith('.old-')))
})

test(
  'refuses a copy holding a pipe, which the script never copies',
  { skip: process.platform === 'win32' },
  () => {
    const { root, plugin } = copy()
    const plugins = mkdtempSync(join(tmpdir(), 'mm-plugins-'))
    try {
      assert.equal(pack(plugin, ['--folder', plugins]).status, 0)
      assert.equal(spawnSync('mkfifo', [join(plugins, 'hello-documents', 'pipe')]).status, 0)
      const out = pack(plugin, ['--folder', plugins])
      assert.notEqual(out.status, 0)
      assert.match(out.stderr, /holds .*pipe, which the script never copies/)
      assert.ok(existsSync(join(plugins, 'hello-documents', 'pipe')))
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(plugins, { recursive: true, force: true })
    }
  },
)

// Review of 4dde2064 (minor 3): a kept copy that cannot be moved aside is said where it is, with the
// scan's warning only while it has the scan's name.
test('says where a kept copy is when it cannot be moved aside', (t) => {
  const { plugins, run } = hooked(t)
  assert.equal(run().status, 0)
  let out = run('clone .pack-kept-')
  assert.equal(out.status, 0, out.stderr)
  assert.match(
    out.stderr,
    /kept, not deleted, at .*\.pack-old-hello-documents\.[^:]*: .*could not be moved aside \(EXDEV\)\n/,
  )
  assert.ok(readdirSync(plugins).some((n) => n.startsWith('.pack-old-hello-documents.')))
  out = run('clone .pack-old- .pack-kept-')
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stderr, /kept, not deleted, at .*\.old-hello-documents\..*before you use Scan again/)
  assert.ok(readdirSync(plugins).some((n) => n.startsWith('.old-hello-documents.')))
})

// Review of 4dde2064 (minor 1): a folder put at the target while the old copy was aside is left
// alone, and the old copy kept where the server's scan leaves it.
test('keeps the old copy, and leaves alone a folder put at the target during the swap', (t) => {
  const { plugins, run } = hooked(t)
  assert.equal(run().status, 0)
  const out = run('occupy')
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /a folder was put there while the copy was swapped in, and was left alone/)
  assert.equal(readFileSync(join(plugins, 'hello-documents', 'theirs.txt'), 'utf8'), 'theirs')
  const kept = readdirSync(plugins).filter((n) => n.startsWith('.pack-kept-hello-documents.'))
  assert.equal(kept.length, 1)
  assert.ok(existsSync(join(plugins, kept[0], 'mongo-manager-plugin.json')))
  assert.ok(!readdirSync(plugins).some((n) => n.startsWith('.old-') || n.startsWith('.pack-hello')))
})

// Review of 4dde2064 (minor 5): a link to nothing at the target is refused as what it is.
test('refuses a link to nothing at the target', { skip: process.platform === 'win32' }, () => {
  const { root, plugin } = copy()
  const plugins = mkdtempSync(join(tmpdir(), 'mm-plugins-'))
  try {
    symlinkSync(join(plugins, 'nowhere'), join(plugins, 'hello-documents'))
    const out = pack(plugin, ['--folder', plugins])
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /exists and is not this plugin's folder/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(plugins, { recursive: true, force: true })
  }
})
