// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginAdminView, PluginRuntimeView } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'
import { helloPlugin, manifestOf } from './support/tar'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function team(overrides: Record<string, unknown> = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  apps.push(t)
  const { ctx } = t.app
  const as = (role: 'admin' | 'editor' | 'viewer') => {
    const user = ctx.users.create({
      username: `u-${role}-${Math.random().toString(36).slice(2, 8)}`,
      passwordHash: 'x',
      role,
    })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const headers = { ...H, 'x-csrf-token': session.csrfToken }
    const call = (method: Method, url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers,
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
    const upload = (archive: Buffer, type = 'application/gzip') =>
      t.app.inject({
        method: 'PUT',
        url: '/api/plugins',
        headers: { ...headers, 'content-type': type },
        cookies: { mm_sid: sessionId },
        payload: archive,
      })
    return { user, call, upload }
  }
  const admin = as('admin')
  const list = async () =>
    ((await admin.call('GET', 'plugins/manage')).json() as { plugins: PluginAdminView[] }).plugins
  const one = async (id: string) => (await list()).find((p) => p.id === id)!
  const root = join(t.dir, 'plugins')
  /** A plugin folder put in place by hand. */
  const folder = (id: string, files: Record<string, string>) => {
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(root, id, ...path.split('/').slice(0, -1)), { recursive: true })
      writeFileSync(join(root, id, ...path.split('/')), data)
    }
  }
  return { t, as, admin, list, one, root, folder }
}

describe('installing plugins (phase 4b §2)', () => {
  it('installs an upload disabled, asking for its permissions; only administrators manage', async () => {
    const { as, admin, one } = await team()
    const res = await admin.upload(helloPlugin())
    expect(res.statusCode).toBe(201)
    const hello = await one('hello')
    expect(hello).toMatchObject({
      source: 'upload',
      enabled: false,
      approvedPermissions: [],
      newPermissions: ['documents:read'],
      fileCount: 3,
      error: null,
    })
    expect(hello.digest).toMatch(/^[0-9a-f]{64}$/)
    const editor = as('editor')
    expect((await editor.call('GET', 'plugins/manage')).statusCode).toBe(403)
    expect((await editor.upload(helloPlugin({ id: 'other' }))).statusCode).toBe(403)
    expect((await editor.call('POST', `plugins/hello/approve`, { digest: hello.digest })).statusCode).toBe(
      403,
    )
    // Nothing runs before an administrator approves it.
    expect((await editor.call('GET', 'plugins')).json()).toEqual([])
  })

  it('enables a plugin approved for the files shown; every user then sees what it adds', async () => {
    const { as, admin, one } = await team()
    await admin.upload(helloPlugin())
    const { digest } = await one('hello')
    expect((await admin.call('POST', 'plugins/hello/approve', { digest: 'f'.repeat(64) })).statusCode).toBe(
      409,
    )
    expect((await admin.call('POST', 'plugins/hello/approve', { digest })).statusCode).toBe(200)
    expect(await one('hello')).toMatchObject({ enabled: true, approvedCurrent: true, newPermissions: [] })
    const runtime = (await as('viewer').call('GET', 'plugins')).json() as PluginRuntimeView[]
    expect(runtime).toEqual([
      expect.objectContaining({
        id: 'hello',
        version: '1.0.0',
        entry: 'index.html',
        permissions: ['documents:read'],
        contributes: expect.objectContaining({ collectionTabs: [expect.objectContaining({ id: 'hi' })] }),
      }),
    ])
    // Settings and files are for administrators.
    expect(JSON.stringify(runtime)).not.toContain('digest')
    expect((await admin.call('POST', 'plugins/hello/disable')).statusCode).toBe(200)
    expect((await as('viewer').call('GET', 'plugins')).json()).toEqual([])
  })

  it('disables a plugin whose files change until it is approved again, naming new permissions', async () => {
    const { admin, one } = await team()
    await admin.upload(helloPlugin())
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    // The same files again: still approved.
    await admin.upload(helloPlugin())
    expect((await one('hello')).enabled).toBe(true)
    await admin.upload(helloPlugin({ version: '1.1.0', permissions: ['documents:read', 'documents:write'] }))
    expect(await one('hello')).toMatchObject({
      enabled: false,
      approvedCurrent: false,
      approvedPermissions: ['documents:read'],
      newPermissions: ['documents:write'],
    })
  })

  it('finds folders put in place by hand, and says why one cannot be used', async () => {
    const { admin, one, folder, root } = await team()
    folder('maps', {
      'mongo-manager-plugin.json': manifestOf({ id: 'maps' }),
      'index.html': 'x',
    })
    folder('wrong-name', { 'mongo-manager-plugin.json': manifestOf({ id: 'other' }), 'index.html': 'x' })
    folder('no-entry', { 'mongo-manager-plugin.json': manifestOf({ id: 'no-entry' }) })
    folder('hidden', {
      'mongo-manager-plugin.json': manifestOf({ id: 'hidden' }),
      'index.html': 'x',
      '.env': 'SECRET=1',
    })
    folder('bad-json', { 'mongo-manager-plugin.json': '{ nope', 'index.html': 'x' })
    mkdirSync(join(root, 'Not_An_Id'))
    expect((await admin.call('POST', 'plugins/scan')).statusCode).toBe(200)
    expect(await one('maps')).toMatchObject({ source: 'folder', error: null, enabled: false })
    expect((await one('wrong-name')).error).toMatch(/id/i)
    expect((await one('no-entry')).error).toMatch(/entry/i)
    expect((await one('hidden')).error).toMatch(/path/i)
    expect((await one('bad-json')).error).toMatch(/manifest|JSON/i)
    expect(await one('Not_An_Id')).toBeUndefined()
    // An invalid one cannot be approved.
    expect(
      (
        await admin.call('POST', 'plugins/wrong-name/approve', {
          digest: (await one('wrong-name')).digest ?? '0'.repeat(64),
        })
      ).statusCode,
    ).toBe(409)
  })

  it('refuses a folder holding a link (it could reach any file)', async (test) => {
    const { admin, one, folder, root } = await team()
    folder('linked', { 'mongo-manager-plugin.json': manifestOf({ id: 'linked' }), 'index.html': 'x' })
    try {
      symlinkSync(join(root, '..'), join(root, 'linked', 'up'), 'junction')
    } catch {
      test.skip()
    }
    await admin.call('POST', 'plugins/scan')
    expect((await one('linked')).error).toMatch(/link/i)
  })

  it('disables an approved folder plugin whose files changed on disk', async () => {
    const { admin, one, folder, root } = await team()
    folder('maps', { 'mongo-manager-plugin.json': manifestOf({ id: 'maps' }), 'index.html': 'x' })
    await admin.call('POST', 'plugins/scan')
    await admin.call('POST', 'plugins/maps/approve', { digest: (await one('maps')).digest })
    expect((await one('maps')).enabled).toBe(true)
    writeFileSync(join(root, 'maps', 'index.html'), '<script>steal()</script>')
    // Approving checks the files as they are now: what was shown is no longer there.
    await admin.call('POST', 'plugins/scan')
    expect(await one('maps')).toMatchObject({ enabled: false, approvedCurrent: false })
    // Put back as approved: still off until an administrator approves it again.
    writeFileSync(join(root, 'maps', 'index.html'), 'x')
    await admin.call('POST', 'plugins/scan')
    expect(await one('maps')).toMatchObject({ enabled: false, approvedCurrent: true })
  })

  it('refuses bad uploads and leaves nothing behind', async () => {
    const { admin, root, list } = await team()
    expect((await admin.upload(Buffer.from('not gzip'))).statusCode).toBe(400)
    expect((await admin.upload(helloPlugin({ entry: 'missing.html' }))).statusCode).toBe(400)
    expect((await admin.upload(helloPlugin({ id: 'Bad_Id' }))).statusCode).toBe(400)
    expect((await admin.upload(helloPlugin({}, [{ name: '../evil.js', data: 'x' }]))).statusCode).toBe(400)
    const plain = await admin.upload(helloPlugin(), 'application/xml')
    expect(plain.statusCode, plain.body).toBe(415)
    expect((await admin.upload(Buffer.alloc(31 * 1024 * 1024))).statusCode).toBe(413)
    expect(await list()).toEqual([])
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('keeps a folder put in place by hand from being replaced by an upload', async () => {
    const { admin, folder } = await team()
    folder('hello', { 'mongo-manager-plugin.json': manifestOf(), 'index.html': 'x' })
    await admin.call('POST', 'plugins/scan')
    expect((await admin.upload(helloPlugin())).statusCode).toBe(409)
  })

  it('takes installs one at a time: two at once leave one plugin, nothing half-written', async () => {
    const { admin, one, root } = await team()
    const [a, b] = await Promise.all([
      admin.upload(helloPlugin()),
      admin.upload(helloPlugin({ version: '2.0.0' })),
    ])
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    expect((await one('hello')).manifest!.version).toBe('2.0.0')
    expect(readdirSync(root).sort()).toEqual(['hello'])
  })

  it('brings a plugin back after a crash between its swap steps', async () => {
    const { admin, root, one } = await team()
    await admin.upload(helloPlugin())
    // As left by a crash after the old folder moved aside, before the new one moved in.
    renameSync(join(root, 'hello'), join(root, '.old-hello.0f0f'))
    mkdirSync(join(root, '.staging-hello.1a1a'))
    await admin.call('POST', 'plugins/scan')
    expect(existsSync(join(root, 'hello', 'index.html'))).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['hello'])
    expect((await one('hello')).error).toBeNull()
  })

  it('checks stored settings again when a new version declares them otherwise', async () => {
    const { admin, one } = await team()
    await admin.upload(
      helloPlugin({
        settings: { tiles: { type: 'url', title: { en: 'T' } }, label: { type: 'text', title: { en: 'L' } } },
      }),
    )
    await admin.call('PUT', 'plugins/hello/settings', {
      values: { tiles: 'https://t.example.org/{z}.png', label: 'x' },
    })
    await admin.upload(
      helloPlugin({ version: '2.0.0', settings: { tiles: { type: 'boolean', title: { en: 'T' } } } }),
    )
    expect((await one('hello')).settings).toEqual({})
  })

  // Review of the security pass (Minor): a plain-http tile server saved before the upgrade was dropped
  // at the next scan without a word, and the map lost its tiles.
  it('keeps an address an upgrade no longer takes for its administrators to see, and gives it to no frame', async () => {
    const { t, admin, one } = await team()
    await admin.upload(helloPlugin({ settings: { tiles: { type: 'url', title: { en: 'T' } } } }))
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    await admin.call('PUT', 'plugins/hello/settings', { values: { tiles: 'https://t.example.org/{z}.png' } })
    // As stored by a version that took plain http to any host.
    const repo = (t.app.ctx.plugins as unknown as { deps: { repo: { put(row: unknown): unknown } } }).deps
      .repo
    repo.put({ ...t.app.ctx.plugins.get('hello')!, settings: { tiles: 'http://tiles.example.org/{z}.png' } })
    expect((await admin.call('POST', 'plugins/scan')).statusCode).toBe(200)
    expect((await one('hello')).settings).toEqual({ tiles: 'http://tiles.example.org/{z}.png' })
    const runtime = (await admin.call('GET', 'plugins')).json() as PluginRuntimeView[]
    expect(runtime.find((p) => p.id === 'hello')!.settings).toEqual({})
  })

  it('saves settings that the manifest declares, each of its type', async () => {
    const { admin, one } = await team()
    await admin.upload(
      helloPlugin({
        settings: {
          tileUrl: { type: 'url', title: { en: 'Tiles' } },
          grid: { type: 'boolean', title: { en: 'Grid' } },
        },
      }),
    )
    const ok = await admin.call('PUT', 'plugins/hello/settings', {
      values: { tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png', grid: true },
    })
    expect(ok.statusCode).toBe(200)
    expect((await one('hello')).settings).toEqual({
      tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png',
      grid: true,
    })
    for (const values of [{ tileUrl: 'javascript:alert(1)' }, { other: 'x' }, { grid: 'yes' }])
      expect((await admin.call('PUT', 'plugins/hello/settings', { values })).statusCode).toBe(400)
  })

  // Security audit 2026-10-16 (minor): a plugin's settings (a tile server address can carry its
  // access token) are sealed with the server's key at rest, like every other saved value.
  it('keeps settings sealed at rest, and opens them for the views', async () => {
    const { t, admin, one, as } = await team()
    await admin.upload(helloPlugin({ settings: { tileUrl: { type: 'url', title: { en: 'Tiles' } } } }))
    const url = 'https://tile.example.org/{z}/{x}/{y}.png?access_token=TOKEN123'
    await admin.call('PUT', 'plugins/hello/settings', { values: { tileUrl: url } })
    const raw = t.app.ctx.store.db.prepare("SELECT settings FROM plugins WHERE id = 'hello'").get() as {
      settings: string
    }
    expect(raw.settings).not.toContain('TOKEN123')
    expect(raw.settings).toMatch(/^v1\./)
    expect((await one('hello')).settings).toEqual({ tileUrl: url })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    const runtime = (await as('viewer').call('GET', 'plugins')).json() as PluginRuntimeView[]
    expect(runtime[0]!.settings).toEqual({ tileUrl: url })
  })

  it('seals settings an older version stored in the clear, at start', async () => {
    const { t } = await team()
    const { PluginRepo } = await import('../src/plugins/repo')
    const db = t.app.ctx.store.db
    const repo = new PluginRepo(db, () => 1)
    repo.put({
      id: 'old',
      source: 'upload',
      manifest: null,
      digest: null,
      files: {},
      bytes: 0,
      error: null,
      enabled: false,
      approvedPermissions: [],
      approvedDigest: null,
      settings: { label: 'CLEAR-VALUE' },
      installedBy: null,
      installedAt: 1,
      updatedFrom: null,
      scan: null,
      origin: null,
      approvalCarried: false,
    })
    const settings = () =>
      (db.prepare("SELECT settings FROM plugins WHERE id = 'old'").get() as { settings: string }).settings
    expect(settings()).toContain('CLEAR-VALUE')
    const sealed = new PluginRepo(db, () => 1, t.app.ctx.secretBox)
    expect(settings()).not.toContain('CLEAR-VALUE')
    expect(sealed.get('old')!.settings).toEqual({ label: 'CLEAR-VALUE' })
  })

  // Independent review of the security pass (minor): one row that cannot be opened breaks nothing else.
  it('marks a plugin whose settings cannot be opened broken, and lists the rest', async () => {
    const { t, admin, one, as } = await team()
    await admin.upload(helloPlugin())
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    await admin.upload(helloPlugin({ id: 'other' }))
    t.app.ctx.store.db.prepare("UPDATE plugins SET settings = 'v1.AAAA.BBBB.CCCC' WHERE id = 'other'").run()
    const manage = await admin.call('GET', 'plugins/manage')
    expect(manage.statusCode).toBe(200)
    expect(await one('other')).toMatchObject({
      enabled: false,
      settings: {},
      error: expect.stringMatching(/settings/),
    })
    const runtime = (await as('viewer').call('GET', 'plugins')).json() as PluginRuntimeView[]
    expect(runtime.map((p) => p.id)).toEqual(['hello'])
  })

  it('removes an uploaded plugin with its folder; a hand-placed folder stays on disk', async () => {
    const { admin, one, folder, root } = await team()
    await admin.upload(helloPlugin())
    expect((await admin.call('DELETE', 'plugins/hello')).statusCode).toBe(204)
    expect(existsSync(join(root, 'hello'))).toBe(false)
    expect(await one('hello')).toBeUndefined()
    folder('maps', { 'mongo-manager-plugin.json': manifestOf({ id: 'maps' }), 'index.html': 'x' })
    await admin.call('POST', 'plugins/scan')
    expect((await admin.call('DELETE', 'plugins/maps')).statusCode).toBe(204)
    expect(existsSync(join(root, 'maps', 'index.html'))).toBe(true)
    expect((await admin.call('DELETE', 'plugins/nope')).statusCode).toBe(404)
  })

  it('audits every change, never a file', async () => {
    const { t, admin, one } = await team()
    await admin.upload(helloPlugin())
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    await admin.call('POST', 'plugins/hello/disable')
    await admin.call('POST', 'plugins/scan')
    await admin.call('DELETE', 'plugins/hello')
    const entries = t.app.ctx.audit.list({ limit: 50 })
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'plugins.upload',
        'plugins.approve',
        'plugins.disable',
        'plugins.scan',
        'plugins.remove',
      ]),
    )
    expect(entries.find((e) => e.action === 'plugins.approve')!.details).toMatchObject({
      id: 'hello',
      version: '1.0.0',
      permissions: ['documents:read'],
    })
    expect(JSON.stringify(entries)).not.toContain('postMessage')
  })

  it('is off entirely with MM_PLUGINS=0', async () => {
    const { admin, as } = await team({ plugins: false })
    expect((await admin.upload(helloPlugin())).statusCode).toBe(403)
    expect((await admin.call('GET', 'plugins/manage')).json()).toMatchObject({ enabled: false, plugins: [] })
    expect((await as('viewer').call('GET', 'plugins')).json()).toEqual([])
  })
})

describe('bundled plugins (phase 4b §4)', () => {
  it('finds them disabled, keeps their id and their files from uploads and removal', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-'))
    mkdirSync(join(bundled, 'hello'), { recursive: true })
    writeFileSync(join(bundled, 'hello', 'mongo-manager-plugin.json'), manifestOf())
    writeFileSync(join(bundled, 'hello', 'index.html'), 'x')
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    expect(await one('hello')).toMatchObject({ source: 'bundled', enabled: false })
    expect((await admin.upload(helloPlugin())).statusCode).toBe(409)
    expect((await admin.call('DELETE', 'plugins/hello')).statusCode).toBe(400)
    // One shipped after start-up, not scanned yet: its id is still its own.
    mkdirSync(join(bundled, 'later'), { recursive: true })
    writeFileSync(join(bundled, 'later', 'mongo-manager-plugin.json'), manifestOf({ id: 'later' }))
    expect((await admin.upload(helloPlugin({ id: 'later' }))).statusCode).toBe(409)
    rmSync(bundled, { recursive: true, force: true })
  })
})

// User request 2026-10-10: a plugin shipped with the app keeps its approval through an update that
// asks for nothing more, saying what it was updated from; anything else waits for an administrator.
describe('updates of bundled plugins', () => {
  const ship = (root: string, over: Record<string, unknown>, html = 'x') => {
    mkdirSync(join(root, 'hello'), { recursive: true })
    writeFileSync(join(root, 'hello', 'mongo-manager-plugin.json'), manifestOf(over))
    writeFileSync(join(root, 'hello', 'index.html'), html)
  }

  it('stays enabled through an update asking for nothing more, saying what it came from', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-up-'))
    ship(bundled, { version: '1.0.0', permissions: ['documents:read'] })
    const { t, admin, one } = await team({ bundledPluginsDir: bundled })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    expect((await one('hello')).enabled).toBe(true)
    // The app is updated: new files, a new version, the same permissions (or fewer).
    ship(bundled, { version: '1.0.3', permissions: [] }, 'y')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: true, approvedCurrent: true, updatedFrom: '1.0.0' })
    // No administrator did it: the move is in the audit log, named.
    const moved = t.app.ctx.audit.list({ limit: 20 }).find((r) => r.action === 'plugins.updated')!
    expect(moved.details).toMatchObject({ id: 'hello', from: '1.0.0', to: '1.0.3' })
    // Every user sees it run.
    const editor = (await (await admin.call('GET', 'plugins')).json()) as Array<{
      id: string
      version: string
    }>
    expect(editor.find((p) => p.id === 'hello')?.version).toBe('1.0.3')
    rmSync(bundled, { recursive: true, force: true })
  })

  it('waits for an administrator when an update asks for a new permission', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-perm-'))
    ship(bundled, { version: '1.0.0', permissions: ['documents:read'] })
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    ship(bundled, { version: '1.1.0', permissions: ['documents:read', 'database:read'] }, 'y')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({
      enabled: false,
      approvedCurrent: false,
      newPermissions: ['database:read'],
    })
    rmSync(bundled, { recursive: true, force: true })
  })

  it('never carries an approval for a bundled plugin that was not approved, nor for a folder one', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-never-'))
    ship(bundled, { version: '1.0.0', permissions: [] })
    const { admin, one, folder, root } = await team({ bundledPluginsDir: bundled })
    ship(bundled, { version: '1.0.1', permissions: [] }, 'y')
    await admin.call('POST', 'plugins/scan')
    // Said (2026-10-11), never approved for it.
    expect(await one('hello')).toMatchObject({ enabled: false, approvedCurrent: false, updatedFrom: '1.0.0' })
    folder('maps', {
      'mongo-manager-plugin.json': manifestOf({ id: 'maps', permissions: [] }),
      'index.html': 'x',
    })
    await admin.call('POST', 'plugins/scan')
    await admin.call('POST', 'plugins/maps/approve', { digest: (await one('maps')).digest })
    writeFileSync(
      join(root, 'maps', 'mongo-manager-plugin.json'),
      manifestOf({ id: 'maps', version: '9.0.0', permissions: [] }),
    )
    await admin.call('POST', 'plugins/scan')
    expect(await one('maps')).toMatchObject({ enabled: false, approvedCurrent: false })
    rmSync(bundled, { recursive: true, force: true })
  })
})

describe('a plugin README', () => {
  it('is read by administrators only, as text, bounded', async () => {
    const { admin, as, folder, root } = await team()
    folder('docs', {
      'mongo-manager-plugin.json': manifestOf({ id: 'docs' }),
      'index.html': 'x',
      'README.md': '# Docs\n\nHow to use it.',
    })
    await admin.call('POST', 'plugins/scan')
    const res = await admin.call('GET', 'plugins/docs/readme')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ text: '# Docs\n\nHow to use it.', truncated: false })
    expect((await as('editor').call('GET', 'plugins/docs/readme')).statusCode).toBe(403)
    folder('bare', { 'mongo-manager-plugin.json': manifestOf({ id: 'bare' }), 'index.html': 'x' })
    await admin.call('POST', 'plugins/scan')
    expect((await admin.call('GET', 'plugins/bare/readme')).json()).toEqual({ text: null, truncated: false })
    writeFileSync(join(root, 'docs', 'README.md'), 'x'.repeat(65 * 1024))
    await admin.call('POST', 'plugins/scan')
    expect((await admin.call('GET', 'plugins/docs/readme')).json().text).toHaveLength(64 * 1024)
    expect((await admin.call('GET', 'plugins/nope/readme')).statusCode).toBe(404)
    expect((await admin.call('GET', 'plugins/..%2F..%2Fetc/readme')).statusCode).toBeGreaterThanOrEqual(400)
  })
})

// Review 2026-10-10 (plugin details): what an approval carries, and what it never does.
describe('carrying a bundled plugin’s approval, never more', () => {
  const bundledDir = () => mkdtempSync(join(tmpdir(), 'mm-bundled-r-'))
  const ship = (root: string, over: Record<string, unknown>, html = 'x') => {
    mkdirSync(join(root, 'hello'), { recursive: true })
    writeFileSync(join(root, 'hello', 'mongo-manager-plugin.json'), manifestOf(over))
    writeFileSync(join(root, 'hello', 'index.html'), html)
  }

  it('never carries an uploaded plugin’s approval to a bundled one of the same id (I1)', async () => {
    const bundled = bundledDir()
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    expect((await admin.upload(helloPlugin())).statusCode).toBe(201)
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    expect((await one('hello')).enabled).toBe(true)
    ship(bundled, { version: '2.0.0', permissions: [] }, 'vendor')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ source: 'bundled', enabled: false, approvedCurrent: false })
    rmSync(bundled, { recursive: true, force: true })
  })

  it('never gives back a permission an update dropped (I2)', async () => {
    const bundled = bundledDir()
    ship(bundled, { version: '1.0.0', permissions: ['documents:read', 'database:read'] })
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    ship(bundled, { version: '1.1.0', permissions: ['documents:read'] }, 'y')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: true, approvedPermissions: ['documents:read'] })
    ship(bundled, { version: '1.2.0', permissions: ['documents:read', 'database:read'] }, 'z')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: false, newPermissions: ['database:read'] })
    rmSync(bundled, { recursive: true, force: true })
  })

  // Review 2026-10-11 (I1): only an approval that moved on its own is said to be kept.
  it('says whether an update kept its approval or an administrator approved it', async () => {
    const bundled = bundledDir()
    ship(bundled, { version: '1.0.0', permissions: ['documents:read'] })
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    expect(await one('hello')).toMatchObject({ approvalCarried: false })
    ship(bundled, { version: '1.1.0', permissions: ['documents:read'] }, 'y')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: true, updatedFrom: '1.0.0', approvalCarried: true })
    // An update asking for more: it waits, and nothing is kept.
    ship(bundled, { version: '1.2.0', permissions: ['documents:read', 'database:read'] }, 'z')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: false, approvalCarried: false })
    // Approved by hand: an administrator's approval.
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    expect(await one('hello')).toMatchObject({ enabled: true, updatedFrom: '1.1.0', approvalCarried: false })
    // Carried again, then approved again by hand: an administrator's approval now.
    ship(bundled, { version: '1.3.0', permissions: ['documents:read', 'database:read'] }, 'w')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: true, approvalCarried: true })
    await admin.call('POST', 'plugins/hello/approve', { digest: (await one('hello')).digest })
    expect(await one('hello')).toMatchObject({ enabled: true, approvalCarried: false })
    rmSync(bundled, { recursive: true, force: true })
  })

  it('keeps a disabled plugin disabled; says nothing was updated on a downgrade (M10); audits the move whole (M7)', async () => {
    const bundled = bundledDir()
    ship(bundled, { version: '1.3.0', permissions: ['documents:read'] })
    const { t, admin, one } = await team({ bundledPluginsDir: bundled })
    const first = (await one('hello')).digest!
    await admin.call('POST', 'plugins/hello/approve', { digest: first })
    ship(bundled, { version: '1.2.0', permissions: ['documents:read'] }, 'older')
    await admin.call('POST', 'plugins/scan')
    expect(await one('hello')).toMatchObject({ enabled: true, updatedFrom: null })
    const moved = t.app.ctx.audit.list({ limit: 20 }).find((r) => r.action === 'plugins.updated')!
    expect(moved.details).toMatchObject({
      id: 'hello',
      from: '1.3.0',
      to: '1.2.0',
      fromDigest: first,
      permissions: ['documents:read'],
    })
    await admin.call('POST', 'plugins/hello/disable')
    ship(bundled, { version: '1.4.0', permissions: ['documents:read'] }, 'newer')
    await admin.call('POST', 'plugins/scan')
    // User report 2026-10-11: a plugin the administrator turned off is not approved for new files on
    // its own — the update is said, and the new code waits for them.
    expect(await one('hello')).toMatchObject({ enabled: false, approvedCurrent: false, updatedFrom: '1.2.0' })
    rmSync(bundled, { recursive: true, force: true })
  })
})

describe('a plugin README, read safely (review 2026-10-10)', () => {
  it('reads nothing that changed or went after the scan; cuts on a character; not while plugins are off', async () => {
    const { t, admin, folder, root } = await team()
    folder('docs', {
      'mongo-manager-plugin.json': manifestOf({ id: 'docs' }),
      'index.html': 'x',
      // Three bytes a character: 64 KiB falls inside one, which is left out whole.
      'README.md': '€'.repeat(30_000),
    })
    await admin.call('POST', 'plugins/scan')
    const cut = (await admin.call('GET', 'plugins/docs/readme')).json() as {
      text: string
      truncated: boolean
    }
    expect(cut.truncated).toBe(true)
    expect(cut.text).not.toContain('\uFFFD')
    expect(cut.text).toBe('€'.repeat(21_845))
    // Changed after the scan: not the text that was shown when it was approved.
    writeFileSync(join(root, 'docs', 'README.md'), 'other words')
    expect((await admin.call('GET', 'plugins/docs/readme')).json()).toEqual({ text: null, truncated: false })
    rmSync(join(root, 'docs', 'README.md'))
    const gone = await admin.call('GET', 'plugins/docs/readme')
    expect(gone.statusCode).toBe(200)
    expect(gone.json()).toEqual({ text: null, truncated: false })
    // Plugins turned off: not read, though the plugin is still known.
    folder('kept', {
      'mongo-manager-plugin.json': manifestOf({ id: 'kept' }),
      'index.html': 'x',
      'README.md': 'hi',
    })
    await admin.call('POST', 'plugins/scan')
    ;(t.app.ctx.plugins as unknown as { deps: { enabled: boolean } }).deps.enabled = false
    expect((await admin.call('GET', 'plugins/kept/readme')).statusCode).not.toBe(200)
  })
})

// User request 2026-10-11: "Her plugin için multilanguage readme ler yaz" — the reader's language first.
describe('a README in the reader’s language', () => {
  it('reads README.<lang>.md when there is one, README.md otherwise; refuses a language that is no code', async () => {
    const { admin, folder } = await team()
    folder('both', {
      'mongo-manager-plugin.json': manifestOf({ id: 'both' }),
      'index.html': 'x',
      'README.md': 'English',
      'README.tr.md': 'Türkçe',
    })
    await admin.call('POST', 'plugins/scan')
    expect((await admin.call('GET', 'plugins/both/readme?lang=tr')).json()).toEqual({
      text: 'Türkçe',
      truncated: false,
    })
    expect((await admin.call('GET', 'plugins/both/readme?lang=en')).json()).toEqual({
      text: 'English',
      truncated: false,
    })
    expect((await admin.call('GET', 'plugins/both/readme?lang=de')).json()).toEqual({
      text: 'English',
      truncated: false,
    })
    expect((await admin.call('GET', 'plugins/both/readme')).json()).toEqual({
      text: 'English',
      truncated: false,
    })
    expect((await admin.call('GET', 'plugins/both/readme?lang=../x')).statusCode).toBe(400)
    const view = (await admin.call('GET', 'plugins/manage'))
      .json()
      .plugins.find((p: { id: string }) => p.id === 'both')
    expect(view.readme).toBe(true)
  })
})

// User request 2026-10-11: no plugin is approved with a bare "yes" over what its scan found.
describe('approving over a security scan', () => {
  it('shows the scan, and approves a plugin with a high finding only when its id is typed', async () => {
    const { t, admin, one } = await team()
    const risky = helloPlugin({}, [{ name: 'evil.js', data: 'el.innerHTML = location.hash' }])
    expect((await admin.upload(risky)).statusCode).toBe(201)
    const view = await one('hello')
    expect(view.scan).toMatchObject({ counts: { high: 1 } })
    expect(view.scan!.findings[0]).toMatchObject({ rule: 'html-injection', file: 'evil.js', line: 1 })
    const bare = await admin.call('POST', 'plugins/hello/approve', { digest: view.digest })
    expect(bare.statusCode).toBe(409)
    expect(bare.json().details).toMatchObject({ reason: 'risk_not_accepted' })
    const wrong = await admin.call('POST', 'plugins/hello/approve', {
      digest: view.digest,
      acceptRisk: 'other',
    })
    expect(wrong.statusCode).toBe(409)
    const ok = await admin.call('POST', 'plugins/hello/approve', { digest: view.digest, acceptRisk: 'hello' })
    expect(ok.statusCode).toBe(200)
    const audit = t.app.ctx.audit.list({ limit: 20 }).find((r) => r.action === 'plugins.approve')!
    expect(audit.details).toMatchObject({ scan: { high: 1, medium: 0, low: 0, info: 0 }, riskAccepted: true })
  })

  it('approves a plugin shipped with the app on a plain approval: it is the app’s own code', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-scan-'))
    mkdirSync(join(bundled, 'hello'), { recursive: true })
    writeFileSync(join(bundled, 'hello', 'mongo-manager-plugin.json'), manifestOf({}))
    writeFileSync(join(bundled, 'hello', 'index.html'), '<script>eval(x)</script>')
    const { admin, one } = await team({ bundledPluginsDir: bundled })
    const view = await one('hello')
    expect(view).toMatchObject({ source: 'bundled', scan: { counts: { high: 1 } } })
    expect((await admin.call('POST', 'plugins/hello/approve', { digest: view.digest })).statusCode).toBe(200)
    rmSync(bundled, { recursive: true, force: true })
  })

  it('approves a plugin with nothing high on a plain approval', async () => {
    const { t, admin, one } = await team()
    expect((await admin.upload(helloPlugin())).statusCode).toBe(201)
    const view = await one('hello')
    expect(view.scan!.counts.high).toBe(0)
    // A typed id with nothing high accepts no risk (review 2026-10-11, minor 2).
    const ok = await admin.call('POST', 'plugins/hello/approve', { digest: view.digest, acceptRisk: 'hello' })
    expect(ok.statusCode).toBe(200)
    const audit = t.app.ctx.audit.list({ limit: 20 }).find((r) => r.action === 'plugins.approve')!
    expect(audit.details).toMatchObject({ riskAccepted: false })
  })

  // Review 2026-10-11 (minor 1): files that changed are said first — their scan is not the one seen.
  it('says the files changed before it asks for a risk to be accepted', async () => {
    const { admin, one } = await team()
    await admin.upload(helloPlugin({}, [{ name: 'evil.js', data: 'eval(x)' }]))
    const seen = (await one('hello')).digest
    await admin.upload(helloPlugin({}, [{ name: 'evil.js', data: 'eval(y)' }]))
    const res = await admin.call('POST', 'plugins/hello/approve', { digest: seen })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('files changed')
    expect(res.json().details?.reason).toBeUndefined()
  })
})
