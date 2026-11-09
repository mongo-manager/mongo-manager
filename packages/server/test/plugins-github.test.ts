// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { PluginAdminView } from '@mongo-manager/shared'
import { EgressError, type Egress, type EgressRequest } from '../src/net/egress'
import { parseGithubRef } from '../src/plugins/github'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { H, makeApp, type TestApp } from './helpers'
import { helloPlugin, manifestOf } from './support/tar'

// User request 2026-10-11: a plugin installed from a public GitHub repository's release — the same
// path as an upload (disabled, scanned, waiting for approval), reaching GitHub's hosts only.
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('a GitHub address', () => {
  it('names a repository, and a release when it has one', () => {
    expect(parseGithubRef('https://github.com/someone/hello')).toEqual({
      owner: 'someone',
      repo: 'hello',
      tag: null,
    })
    expect(parseGithubRef(' https://github.com/Some-One/hello.js.git/ ')).toEqual({
      owner: 'Some-One',
      repo: 'hello.js',
      tag: null,
    })
    expect(parseGithubRef('https://github.com/someone/hello/releases')).toMatchObject({ tag: null })
    expect(parseGithubRef('https://github.com/someone/hello/releases/latest')).toMatchObject({ tag: null })
    expect(parseGithubRef('https://GitHub.com/someone/hello/releases/tag/v1.2.0')).toMatchObject({
      tag: 'v1.2.0',
    })
    // A tag may hold slashes (review 2026-10-11).
    expect(parseGithubRef('https://github.com/someone/hello/releases/tag/team/v1.2.0')).toMatchObject({
      tag: 'team/v1.2.0',
    })
  })

  it('refuses anything else: another host or scheme, credentials, a port, odd names, more', () => {
    for (const bad of [
      'http://github.com/someone/hello',
      'https://github.com.evil.example/someone/hello',
      'https://gist.github.com/someone/hello',
      'https://api.github.com/repos/someone/hello',
      'https://user:pw@github.com/someone/hello',
      'https://github.com:8443/someone/hello',
      'https://github.com/someone',
      'https://github.com/someone/..',
      'https://github.com/-someone/hello',
      'https://github.com/someone/hel lo',
      'https://github.com/someone/hello?tab=readme',
      'https://github.com/someone/hello#readme',
      'https://github.com/someone/hello/tree/main',
      'https://github.com/someone/hello/releases/tag/../../x',
      'https://github.com/someone/hello/releases/tag/a%2Fb',
      `https://github.com/someone/${'x'.repeat(101)}`,
      'github.com/someone/hello',
      'javascript:alert(1)',
    ])
      expect(() => parseGithubRef(bad), bad).toThrow()
  })
})

type Answer =
  | { status: number; body: Buffer | object; headers?: Record<string, string> }
  | { redirect: string }
  | { error: EgressError }

/** GitHub as the test sees it: an answer for each address, every request recorded. */
function fakeGithub(answers: Record<string, Answer>) {
  const asked: EgressRequest[] = []
  const buffer: Egress['buffer'] = async (r, limit = 1024 * 1024) => {
    asked.push(r)
    const url = String(r.url)
    const a = answers[url]
    if (!a) throw new EgressError('connect', 'The destination cannot be reached')
    if ('error' in a) throw a.error
    if ('redirect' in a)
      throw new EgressError(
        'redirect',
        'The destination answered with a redirect; redirects are not followed',
        new URL(a.redirect).host,
        a.redirect,
      )
    const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(JSON.stringify(a.body))
    if (body.length > limit) throw new EgressError('too_large', 'The destination sent too large an answer')
    return { status: a.status, headers: a.headers ?? {}, body }
  }
  const egress: Egress = {
    buffer,
    request: () => Promise.reject(new Error('not used')),
    probe: () => Promise.reject(new Error('not used')),
    listed: () => false,
  }
  return { egress, asked }
}

const API = 'https://api.github.com/repos/someone/hello'
const ASSET = 'https://github.com/someone/hello/releases/download/v1.0.0/hello-1.0.0.tgz'
const SIGNED = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc'
const release = (
  assets: Array<{ name: string; size?: number; url?: string; digest?: string | null }>,
  tag = 'v1.0.0',
) => ({
  status: 200,
  body: {
    tag_name: tag,
    html_url: `https://github.com/someone/hello/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: assets.map((a, i) => ({
      id: i + 1,
      name: a.name,
      size: a.size ?? 2048,
      browser_download_url: a.url ?? ASSET,
      ...(a.digest !== undefined ? { digest: a.digest } : {}),
    })),
  },
})

async function team(answers: Record<string, Answer>, overrides: Record<string, unknown> = {}) {
  const t = await makeApp({ auth: true, pluginsGithub: true, ...overrides })
  apps.push(t)
  const { ctx } = t.app
  const github = fakeGithub(answers)
  ctx.pluginsEgress = github.egress
  const as = (role: 'admin' | 'editor') => {
    const user = ctx.users.create({ username: `u-${role}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        ...(payload ? { payload } : {}),
      })
  }
  const admin = as('admin')
  const install = (url: string) => admin('POST', 'plugins/github', { url })
  const list = async () =>
    (await admin('GET', 'plugins/manage')).json() as { github: boolean; plugins: PluginAdminView[] }
  return { t, as, admin, install, list, asked: github.asked }
}

describe('installing a plugin from GitHub', () => {
  // Security review 2026-10-13 (ops): GitHub names each asset's SHA-256; an archive that is not
  // the one the release published (changed on the way, or behind GitHub's back) is never installed.
  it('installs only the archive whose SHA-256 the release names', async () => {
    const archive = helloPlugin()
    const sha = createHash('sha256').update(archive).digest('hex')
    const good = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello-1.0.0.tgz', digest: `sha256:${sha}` }]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: archive },
    })
    expect((await good.install('https://github.com/someone/hello')).statusCode).toBe(201)
    const bad = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello-1.0.0.tgz', digest: `sha256:${'0'.repeat(64)}` }]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: archive },
    })
    const res = await bad.install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(502)
    expect(res.json().details).toMatchObject({ reason: 'github_digest' })
    expect((await bad.list()).plugins.find((p) => p.id === 'hello')).toBeUndefined()
    // The archive's digest in another algorithm cannot be checked: refused, saying so (review M3).
    const odd = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello-1.0.0.tgz', digest: 'sha512:abc' }]),
    })
    const refused = await odd.install('https://github.com/someone/hello')
    expect(refused.statusCode).toBe(502)
    expect(refused.json().details).toMatchObject({ reason: 'github_digest_unknown' })
    // Another asset's digest is none of its business.
    const other = await team({
      [`${API}/releases/latest`]: release([
        { name: 'hello-1.0.0.tgz', digest: `sha256:${sha.toUpperCase()}` },
        { name: 'notes.txt', digest: 'blake3:whatever' },
      ]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: archive },
    })
    expect((await other.install('https://github.com/someone/hello')).statusCode).toBe(201)
  })

  it('installs the release’s archive as an upload would: off, scanned, waiting for approval', async () => {
    const { t, install, list, asked } = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello-1.0.0.tgz' }]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: helloPlugin() },
    })
    const res = await install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(201)
    const { github, plugins } = await list()
    expect(github).toBe(true)
    expect(plugins.find((p) => p.id === 'hello')).toMatchObject({
      source: 'upload',
      enabled: false,
      approvedCurrent: false,
      origin: {
        kind: 'github',
        repository: 'someone/hello',
        release: 'v1.0.0',
        asset: 'hello-1.0.0.tgz',
        url: 'https://github.com/someone/hello/releases/tag/v1.0.0',
      },
    })
    expect(plugins.find((p) => p.id === 'hello')!.scan).not.toBeNull()
    expect(asked.map((r) => String(r.url))).toEqual([`${API}/releases/latest`, ASSET, SIGNED])
    // Nothing of the server's goes to GitHub: no cookie, no token, no credentials.
    for (const r of asked) {
      expect(r.method).toBe('GET')
      expect(Object.keys(r.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization')
      expect(Object.keys(r.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('cookie')
    }
    const audit = t.app.ctx.audit.list({ limit: 10 }).find((r) => r.action === 'plugins.github')!
    expect(audit.details).toMatchObject({ repository: 'someone/hello', release: 'v1.0.0', id: 'hello' })
  })

  it('takes the release named in the address', async () => {
    const { install, asked } = await team({
      [`${API}/releases/tags/v0.9.0`]: release([{ name: 'hello.tgz' }], 'v0.9.0'),
      [ASSET]: { status: 200, body: helloPlugin() },
    })
    expect((await install('https://github.com/someone/hello/releases/tag/v0.9.0')).statusCode).toBe(201)
    expect(String(asked[0]!.url)).toBe(`${API}/releases/tags/v0.9.0`)
  })

  it('follows redirects only to GitHub’s own hosts, over https, a few at most', async () => {
    const cases: Array<[string, Record<string, Answer>]> = [
      ['another host', { [ASSET]: { redirect: 'https://evil.example.org/x.tgz' } }],
      ['plain http', { [ASSET]: { redirect: 'http://release-assets.githubusercontent.com/x' } }],
      ['credentials', { [ASSET]: { redirect: 'https://u:p@release-assets.githubusercontent.com/x' } }],
      ['a port', { [ASSET]: { redirect: 'https://release-assets.githubusercontent.com:8443/x' } }],
      [
        'a lookalike',
        { [ASSET]: { redirect: 'https://release-assets.githubusercontent.com.evil.example/x' } },
      ],
    ]
    for (const [name, hops] of cases) {
      const { install, list } = await team({
        [`${API}/releases/latest`]: release([{ name: 'hello.tgz' }]),
        ...hops,
      })
      const res = await install('https://github.com/someone/hello')
      expect(res.statusCode, name).toBe(502)
      expect(res.json().details, name).toMatchObject({ reason: 'github_redirect' })
      expect((await list()).plugins, name).toEqual([])
    }
    // Too many redirects, each allowed: said as such (review 2026-10-11).
    const endless = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello.tgz' }]),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          i === 0 ? ASSET : `https://objects.githubusercontent.com/${i}`,
          { redirect: `https://objects.githubusercontent.com/${i + 1}` },
        ]),
      ),
    })
    const res = await endless.install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(502)
    expect(res.json().details).toMatchObject({ reason: 'github_redirects' })
  })

  // Review 2026-10-11: one deadline for the whole install, however many redirects.
  it('gives every request what is left of one deadline', async () => {
    const { install, asked } = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello.tgz' }]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: helloPlugin() },
    })
    expect((await install('https://github.com/someone/hello')).statusCode).toBe(201)
    const deadlines = asked.map((r) => r.deadlineMs!)
    for (const d of deadlines) {
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThanOrEqual(4 * 60_000)
    }
    expect([...deadlines].sort((a, b) => b - a)).toEqual(deadlines)
    // The first request has the whole of it.
    expect(deadlines[0]).toBeGreaterThan(4 * 60_000 - 10_000)
  })

  // Review 2026-10-11: a renamed repository's release is found under its new name.
  it('follows a repository renamed on GitHub, by the release’s own address', async () => {
    const renamed = 'https://github.com/someone-new/hello-plugin/releases/download/v1.0.0/hello.tgz'
    const { install, list } = await team({
      [`${API}/releases/latest`]: {
        status: 200,
        body: {
          tag_name: 'v1.0.0',
          html_url: 'https://github.com/someone-new/hello-plugin/releases/tag/v1.0.0',
          assets: [{ name: 'hello.tgz', size: 2048, browser_download_url: renamed }],
        },
      },
      [renamed]: { status: 200, body: helloPlugin() },
    })
    expect((await install('https://github.com/someone/hello')).statusCode).toBe(201)
    expect((await list()).plugins[0]!.origin).toMatchObject({
      repository: 'someone-new/hello-plugin',
      url: 'https://github.com/someone-new/hello-plugin/releases/tag/v1.0.0',
    })
  })

  it('refuses a release whose names hide anything, or whose address is not GitHub’s', async () => {
    for (const body of [
      { tag_name: 'v1\u202e0', assets: [{ name: 'hello.tgz', size: 1, browser_download_url: ASSET }] },
      { tag_name: 'v1', assets: [{ name: 'hel\u0007lo.tgz', size: 1, browser_download_url: ASSET }] },
      {
        tag_name: 'v1',
        html_url: 'https://evil.example.org/someone/hello/releases/tag/v1',
        assets: [{ name: 'hello.tgz', size: 1, browser_download_url: ASSET }],
      },
    ]) {
      const { install } = await team({ [`${API}/releases/latest`]: { status: 200, body } })
      const res = await install('https://github.com/someone/hello')
      expect(res.statusCode).toBe(502)
      expect(res.json().details).toMatchObject({ reason: 'github_failed' })
    }
  })

  it('downloads only an asset of that repository’s releases', async () => {
    const { install } = await team({
      [`${API}/releases/latest`]: release([
        { name: 'hello.tgz', url: 'https://evil.example.org/someone/hello/releases/download/v1/hello.tgz' },
      ]),
    })
    const res = await install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(502)
    expect(res.json().details).toMatchObject({ reason: 'github_asset' })
    const other = await team({
      [`${API}/releases/latest`]: release([
        { name: 'hello.tgz', url: 'https://github.com/other/repo/releases/download/v1/hello.tgz' },
      ]),
    })
    expect((await other.install('https://github.com/someone/hello')).json().details).toMatchObject({
      reason: 'github_asset',
    })
  })

  it('needs exactly one plugin archive in the release, no larger than an upload', async () => {
    const none = await team({ [`${API}/releases/latest`]: release([{ name: 'notes.zip' }]) })
    const r1 = await none.install('https://github.com/someone/hello')
    expect(r1.statusCode).toBe(400)
    expect(r1.json().details).toMatchObject({ reason: 'github_no_archive' })
    const two = await team({
      [`${API}/releases/latest`]: release([{ name: 'a.tgz' }, { name: 'b.tar.gz' }]),
    })
    const r2 = await two.install('https://github.com/someone/hello')
    expect(r2.statusCode).toBe(400)
    expect(r2.json().details).toMatchObject({ reason: 'github_many_archives', names: ['a.tgz', 'b.tar.gz'] })
    const big = await team({
      [`${API}/releases/latest`]: release([{ name: 'a.tgz', size: 31 * 1024 * 1024 }]),
    })
    expect((await big.install('https://github.com/someone/hello')).statusCode).toBe(413)
    // An asset larger than it said is cut off at the limit all the same.
    const liar = await team({
      [`${API}/releases/latest`]: release([{ name: 'a.tgz', size: 10 }]),
      [ASSET]: { status: 200, body: Buffer.alloc(31 * 1024 * 1024) },
    })
    expect((await liar.install('https://github.com/someone/hello')).statusCode).toBe(413)
  })

  it('says why GitHub could not help: no release, a limit, unreachable, an answer not understood', async () => {
    const cases: Array<[Answer, number, string]> = [
      [{ status: 404, body: { message: 'Not Found' } }, 404, 'github_not_found'],
      [
        {
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0' },
        },
        429,
        'github_rate_limited',
      ],
      [{ status: 403, body: { message: 'Repository access blocked' } }, 502, 'github_forbidden'],
      // A release over 5 MB, valid otherwise: not read whole.
      [
        {
          status: 200,
          body: {
            tag_name: 'v1',
            body: 'x'.repeat(6 * 1024 * 1024),
            assets: [{ name: 'hello.tgz', size: 1, browser_download_url: ASSET }],
          },
        },
        502,
        'github_failed',
      ],
      [{ status: 429, body: {} }, 429, 'github_rate_limited'],
      [{ status: 500, body: {} }, 502, 'github_failed'],
      [
        { error: new EgressError('dns', 'The destination’s name does not resolve') },
        502,
        'github_unreachable',
      ],
      [{ status: 200, body: Buffer.from('not json') }, 502, 'github_failed'],
      [{ status: 200, body: { tag_name: 1, assets: 'x' } }, 502, 'github_failed'],
    ]
    for (const [answer, status, reason] of cases) {
      const { install } = await team({ [`${API}/releases/latest`]: answer })
      const res = await install('https://github.com/someone/hello')
      expect(res.statusCode, reason).toBe(status)
      expect(res.json().details, reason).toMatchObject({ reason })
      // What GitHub said is never passed on as ours.
      expect(res.body).not.toContain('API rate limit exceeded')
      expect(res.body).not.toContain('Repository access blocked')
    }
  })

  it('is for administrators, refuses a bad address before reaching out, and can be turned off', async () => {
    const { as, install, asked } = await team({})
    const editor = as('editor')
    expect(
      (await editor('POST', 'plugins/github', { url: 'https://github.com/someone/hello' })).statusCode,
    ).toBe(403)
    expect((await install('https://evil.example.org/someone/hello')).statusCode).toBe(400)
    expect((await install('https://github.com/someone/hello?x=1')).statusCode).toBe(400)
    expect(asked).toEqual([])
    const off = await team({}, { pluginsGithub: false })
    const res = await off.install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'github_off' })
    expect((await off.list()).github).toBe(false)
    expect(off.asked).toEqual([])
  })

  it('installs nothing that is not a plugin archive', async () => {
    const { install, list } = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello.tgz' }]),
      [ASSET]: { status: 200, body: Buffer.from('not a tarball') },
    })
    const res = await install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(400)
    expect((await list()).plugins).toEqual([])
  })

  it('installs nothing of a bundled plugin’s id, as an upload would not', async () => {
    const bundled = mkdtempSync(join(tmpdir(), 'mm-bundled-gh-'))
    mkdirSync(join(bundled, 'hello'), { recursive: true })
    writeFileSync(join(bundled, 'hello', 'mongo-manager-plugin.json'), manifestOf({}))
    writeFileSync(join(bundled, 'hello', 'index.html'), 'shipped')
    const { install, list } = await team(
      {
        [`${API}/releases/latest`]: release([{ name: 'hello.tgz' }]),
        [ASSET]: { status: 200, body: helloPlugin() },
      },
      { bundledPluginsDir: bundled },
    )
    const res = await install('https://github.com/someone/hello')
    expect(res.statusCode).toBe(409)
    expect((await list()).plugins).toMatchObject([{ id: 'hello', source: 'bundled', origin: null }])
    rmSync(bundled, { recursive: true, force: true })
  })
})

// User request 2026-10-12: installs from GitHub are off for now — a server turns them on by itself
// (MM_PLUGINS_GITHUB=1); with nothing set, nothing reaches GitHub.
describe('installs from GitHub by default', () => {
  it('are off: the Plugins page offers none, and the server asks GitHub nothing', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const github = fakeGithub({})
    ctx.pluginsEgress = github.egress
    const user = ctx.users.create({ username: 'u-admin', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({
        method,
        url: `/api/${url}`,
        headers: { ...H, cookie: `mm_sid=${sessionId}`, 'x-csrf-token': session.csrfToken },
        ...(payload ? { payload } : {}),
      })
    expect((await call('GET', 'plugins/manage')).json().github).toBe(false)
    const res = await call('POST', 'plugins/github', { url: 'https://github.com/someone/hello' })
    expect(res.statusCode).toBe(403)
    expect(res.json().details).toMatchObject({ reason: 'github_off' })
    expect(github.asked).toEqual([])
  })

  // Review 2026-10-12: turning installs off leaves the plugins installed from GitHub as they are.
  it('leaves a plugin installed from GitHub working once installs are turned off', async () => {
    const { t, admin, install, list } = await team({
      [`${API}/releases/latest`]: release([{ name: 'hello-1.0.0.tgz' }]),
      [ASSET]: { redirect: SIGNED },
      [SIGNED]: { status: 200, body: helloPlugin() },
    })
    expect((await install('https://github.com/someone/hello')).statusCode).toBe(201)
    ;(t.app.ctx.config as { pluginsGithub: boolean }).pluginsGithub = false
    const { github, plugins } = await list()
    expect(github).toBe(false)
    const hello = plugins.find((p) => p.id === 'hello')!
    expect(hello.origin).toMatchObject({ kind: 'github' })
    expect((await admin('POST', 'plugins/hello/approve', { digest: hello.digest })).statusCode).toBe(200)
    expect((await admin('GET', 'plugins/hello/ticket')).statusCode).toBe(200)
  })
})

// Review 2026-10-11 (I6): the server's own GitHub egress reaches public addresses only.
describe('the GitHub egress', () => {
  it('refuses this machine, private networks and cloud metadata', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    for (const url of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest'])
      await expect(t.app.ctx.pluginsEgress.buffer({ method: 'GET', url }), url).rejects.toMatchObject({
        reason: expect.stringMatching(/^address_(refused|never)$/),
      })
  })

  it('keeps a redirect’s whole address out of what is logged', () => {
    const e = new EgressError('redirect', 'm', 'x.example', 'https://x.example/a?signature=secret')
    expect(e.location).toBe('https://x.example/a?signature=secret')
    expect(Object.keys(e)).not.toContain('location')
    expect(JSON.stringify(e)).not.toContain('secret')
  })
})
