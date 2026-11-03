import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { UI_LANGUAGES } from '@mongo-manager/shared'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { buildApp, RATE_LIMIT_ASSETS, RATE_LIMIT_WEB } from '../src/http/app'
import { resolveConfig, type PartialConfig } from '../src/config'
import { openStore } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

type Source = 'directory' | 'embedded'

/** The same build as an in-memory table, the way a standalone binary carries it. */
function embed(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    files.set(relative(root, full).split(sep).join('/'), readFileSync(full))
  }
  return files
}

async function appWithWeb(overrides: PartialConfig = {}, webDir = 'web', source: Source = 'directory') {
  const dir = mkdtempSync(join(tmpdir(), 'mm-web-'))
  const web = join(dir, webDir)
  mkdirSync(join(web, 'assets'), { recursive: true })
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><html><head><base href="/" /><script type="module" src="./assets/app.js"></script></head><body></body></html>',
  )
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(web, 'favicon.svg'), '<svg/>')
  writeFileSync(join(web, '.env'), 'SECRET=hidden-file')
  writeFileSync(join(web, 'assets', 'app.css'), 'body{}')
  mkdirSync(join(web, 'docs', 'tr'), { recursive: true })
  writeFileSync(join(web, 'docs', 'index.html'), '<!doctype html><title>Docs</title>')
  writeFileSync(join(web, 'docs', 'tr', 'index.html'), '<!doctype html><title>Belgeler</title>')
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"Mongo Manager"}')
  const config = resolveConfig({ cli: { dataDir: dir, logLevel: 'silent', ...overrides } })
  const store = await openStore(dir)
  const app = await buildApp({
    config,
    store,
    secretBox: createSecretBox(randomBytes(32)),
    ...(source === 'directory' ? { webRoot: web } : { webAssets: embed(web) }),
  })
  cleanups.push(async () => {
    await app.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return app
}

const H = { host: 'localhost:4321' }

describe.each<Source>(['directory', 'embedded'])('web app serving from a %s (Review Focus 1)', (source) => {
  it('serves index.html, hashed assets with long caching, and the SPA for deep links', async () => {
    const app = await appWithWeb({}, undefined, source)
    const index = await app.inject({ method: 'GET', url: '/', headers: H })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-type']).toMatch(/text\/html/)
    expect(index.headers['cache-control']).toBe('no-cache')
    expect(index.headers['content-security-policy']).toContain("script-src 'self'")
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toContain('immutable')
    const deep = await app.inject({
      method: 'GET',
      url: '/some/client/route',
      headers: { ...H, accept: 'text/html' },
    })
    expect(deep.statusCode).toBe(200)
    expect(deep.body).toContain('<base href="/" />')
  })

  it('keeps API 404s as JSON and never serves the SPA for API paths or non-GET requests', async () => {
    const app = await appWithWeb({}, undefined, source)
    const api = await app.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { ...H, accept: 'text/html' },
    })
    expect(api.statusCode).toBe(404)
    expect(api.json().code).toBe('NOT_FOUND')
    const post = await app.inject({
      method: 'POST',
      url: '/some/route',
      headers: { ...H, accept: 'text/html', origin: 'http://localhost:4321' },
    })
    // CSRF protection answers first (403); either way it is a JSON error, never the SPA.
    expect(post.statusCode).toBeGreaterThanOrEqual(400)
    expect(post.headers['content-type']).toMatch(/application\/json/)
  })

  it('rewrites <base href> and mounts everything under basePath', async () => {
    const app = await appWithWeb({ basePath: '/mm/' }, undefined, source)
    const index = await app.inject({ method: 'GET', url: '/mm/', headers: H })
    expect(index.body).toContain('<base href="/mm/" />')
    expect((await app.inject({ method: 'GET', url: '/mm/assets/app.js', headers: H })).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/mm/deep/link', headers: { ...H, accept: 'text/html' } }))
        .body,
    ).toContain('<base href="/mm/" />')
    expect((await app.inject({ method: 'GET', url: '/mm/api/nope', headers: H })).json().code).toBe(
      'NOT_FOUND',
    )
    expect((await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })).statusCode).toBe(404)
  })

  it('refuses path traversal out of the web root', async () => {
    const app = await appWithWeb({}, undefined, source)
    const res = await app.inject({ method: 'GET', url: '/assets/..%2F..%2Fmongo-manager.db', headers: H })
    expect(res.statusCode).not.toBe(200)
  })

  it('never serves a file outside the build or a hidden file, however the path is spelled', async () => {
    const app = await appWithWeb({}, undefined, source)
    for (const url of [
      '/assets/%2e%2e/%2e%2e/mongo-manager.db',
      '/assets/..%5c..%5cmongo-manager.db',
      '/%2e%2e/secret.key',
      '/.env',
      '/assets/.%2e/.env',
      '/%2eenv',
      '/assets/app.js%00.html',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: H })
      expect(res.body, url).not.toContain('hidden-file')
      expect(res.statusCode === 200 ? res.headers['content-type'] : 'refused', url).toMatch(
        /refused|text\/html/,
      )
    }
  })

  it('answers HEAD and sets content types from the extension', async () => {
    const app = await appWithWeb({}, undefined, source)
    const head = await app.inject({ method: 'HEAD', url: '/assets/app.js', headers: H })
    expect(head.statusCode).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toMatch(/javascript/)
    const css = await app.inject({ method: 'GET', url: '/assets/app.css', headers: H })
    expect(css.headers['content-type']).toMatch(/^text\/css/)
    const svg = await app.inject({ method: 'GET', url: '/favicon.svg', headers: H })
    expect(svg.headers['content-type']).toMatch(/^image\/svg\+xml/)
    expect(svg.headers['x-content-type-options']).toBe('nosniff')
  })

  // CI 2026-11-01: a page load is hundreds of build files; a team opening the app behind one
  // address (or a long test run) ran out of the page budget and the app half loaded. The build's
  // files have a bucket of their own, still bounded; the other pages keep theirs.
  it('gives the build files a larger bucket of their own, still bounded', async () => {
    // The limiter's minute is read from Date.now(): on a busy machine the 20 000 requests outlast it
    // and the bucket refills (full run 2026-11-02). The clock stands still; the timers still run.
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => void vi.useRealTimers())
    const app = await appWithWeb({}, undefined, source)
    const get = (url: string) => app.inject({ method: 'GET', url, headers: H })
    for (let i = 0; i < RATE_LIMIT_WEB; i++) await get('/assets/app.js')
    expect((await get('/assets/app.js')).statusCode).toBe(200)
    for (let i = 0; i < RATE_LIMIT_WEB; i++) await get('/favicon.svg')
    expect((await get('/favicon.svg')).statusCode).toBe(429)
    for (let i = RATE_LIMIT_WEB + 1; i < RATE_LIMIT_ASSETS; i++) await get('/assets/app.css')
    expect((await get('/assets/app.css')).statusCode).toBe(429)
  }, 120_000)
})

describe('embedded web assets', () => {
  async function embeddedApp(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'mm-web-'))
    const config = resolveConfig({ cli: { dataDir: dir, logLevel: 'silent' } })
    const store = await openStore(dir)
    const app = await buildApp({
      config,
      store,
      secretBox: createSecretBox(randomBytes(32)),
      webAssets: new Map(
        Object.entries({ 'index.html': '<!doctype html><base href="/" />', ...files }).map(([k, v]) => [
          k,
          new TextEncoder().encode(v),
        ]),
      ),
    })
    cleanups.push(async () => {
      await app.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return app
  }

  it('answer conditional requests with 304 through a content ETag (final review Minor 8)', async () => {
    const app = await embeddedApp({ 'assets/app.js': 'console.log(1)' })
    const first = await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })
    const etag = first.headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]{16,}"$/)
    const again = await app.inject({
      method: 'GET',
      url: '/assets/app.js',
      headers: { ...H, 'if-none-match': etag },
    })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    expect(first.headers['accept-ranges']).toBe('none')
  })

  it('know the content types a web build can contain', async () => {
    const app = await embeddedApp({
      'a.jpg': 'x',
      'a.gif': 'x',
      'a.avif': 'x',
      'a.otf': 'x',
      'site.webmanifest': '{}',
      'a.xml': '<a/>',
    })
    const type = async (url: string) =>
      (await app.inject({ method: 'GET', url, headers: H })).headers['content-type']
    expect(await type('/a.jpg')).toBe('image/jpeg')
    expect(await type('/a.gif')).toBe('image/gif')
    expect(await type('/a.avif')).toBe('image/avif')
    expect(await type('/a.otf')).toBe('font/otf')
    expect(await type('/site.webmanifest')).toMatch(/^application\/manifest\+json/)
    expect(await type('/a.xml')).toMatch(/^application\/xml/)
  })

  it('win over a web root when both are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-web-'))
    const config = resolveConfig({ cli: { dataDir: dir, logLevel: 'silent' } })
    const store = await openStore(dir)
    const html = '<!doctype html><html><head><base href="/" /></head><body>embedded</body></html>'
    const app = await buildApp({
      config,
      store,
      secretBox: createSecretBox(randomBytes(32)),
      webRoot: join(dir, 'nowhere'),
      webAssets: new Map([['index.html', new TextEncoder().encode(html)]]),
    })
    cleanups.push(async () => {
      await app.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect((await app.inject({ method: 'GET', url: '/', headers: H })).body).toContain('embedded')
  })
})

describe.each<Source>(['directory', 'embedded'])('web app serving edge cases from a %s', (source) => {
  it('redirects the bare base path to its trailing-slash form', async () => {
    const app = await appWithWeb({ basePath: '/mm/' }, undefined, source)
    const res = await app.inject({ method: 'GET', url: '/mm', headers: { ...H, accept: 'text/html' } })
    expect(res.statusCode).toBe(308)
    expect(res.headers.location).toBe('/mm/')
  })

  it('serves index.html itself with the rewritten <base href>', async () => {
    const app = await appWithWeb({ basePath: '/mm/' }, undefined, source)
    const res = await app.inject({
      method: 'GET',
      url: '/mm/index.html',
      headers: { ...H, accept: 'text/html' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<base href="/mm/" />')
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('decides long caching by the path inside the web root, not by parent folder names', async () => {
    const app = await appWithWeb({}, join('assets', 'web'), source)
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: H })
    expect(favicon.statusCode).toBe(200)
    expect(favicon.headers['cache-control']).toBe('no-cache')
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })
    expect(asset.headers['cache-control']).toContain('immutable')
  })
})

describe.each<Source>(['directory', 'embedded'])('PWA files from a %s (phase 1g-2)', (source) => {
  it('serves the service worker and manifest with their types and without long caching', async () => {
    const app = await appWithWeb({}, undefined, source)
    const sw = await app.inject({ method: 'GET', url: '/sw.js', headers: H })
    expect(sw.statusCode).toBe(200)
    expect(sw.headers['content-type']).toMatch(/javascript/)
    expect(sw.headers['cache-control']).toBe('no-cache')
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest', headers: H })
    expect(manifest.headers['content-type']).toMatch(/^application\/manifest\+json/)
    expect(manifest.headers['cache-control']).toBe('no-cache')
  })
})

describe.each<Source>(['directory', 'embedded'])('offline docs from a %s (phase 1g-2)', (source) => {
  it('send /docs and /docs/ to the docs start page, under any base path', async () => {
    for (const basePath of ['/', '/mm/']) {
      const app = await appWithWeb({ basePath }, undefined, source)
      for (const url of [`${basePath}docs`, `${basePath}docs/`]) {
        const res = await app.inject({ method: 'GET', url, headers: { ...H, accept: 'text/html' } })
        expect(res.statusCode, url).toBe(302)
        expect(res.headers.location, url).toBe(`${basePath}docs/index.html`)
      }
    }
  })
})

describe.each<Source>(['directory', 'embedded'])('final review 1g-2 fixes from a %s', (source) => {
  it('never answers a missing asset with the app page, so nothing can cache it as a script (I1)', async () => {
    for (const basePath of ['/', '/mm/']) {
      const app = await appWithWeb({ basePath }, undefined, source)
      const res = await app.inject({
        method: 'GET',
        url: `${basePath}assets/index-12345678.js`,
        headers: { ...H, accept: '*/*' },
      })
      expect(res.statusCode, basePath).toBe(404)
      expect(res.headers['content-type'], basePath).not.toMatch(/text\/html/)
    }
  })

  it('sends /docs/tr and /docs/tr/ to the Turkish start page (Minor 11)', async () => {
    const app = await appWithWeb({}, undefined, source)
    for (const url of ['/docs/tr', '/docs/tr/']) {
      const res = await app.inject({ method: 'GET', url, headers: { ...H, accept: 'text/html' } })
      expect(res.statusCode, url).toBe(302)
      expect(res.headers.location, url).toBe('/docs/tr/index.html')
    }
  })

  // Review of the languages (minor 2): every language's docs folder opens its start page, never the app.
  it('sends every language’s docs folder to its start page', async () => {
    const app = await appWithWeb({}, undefined, source)
    for (const lang of UI_LANGUAGES.filter((l) => l !== 'en'))
      for (const url of [`/docs/${lang}`, `/docs/${lang}/`]) {
        const res = await app.inject({ method: 'GET', url, headers: { ...H, accept: 'text/html' } })
        expect(res.statusCode, url).toBe(302)
        expect(res.headers.location, url).toBe(`/docs/${lang}/index.html`)
      }
  })

  it('opens the app for deep links whose names start with a dot (Minor 12)', async () => {
    const app = await appWithWeb({}, undefined, source)
    for (const url of ['/c/c1/db/a/coll/.hidden', '/c/c1/db/.b/coll/x']) {
      const res = await app.inject({ method: 'GET', url, headers: { ...H, accept: 'text/html' } })
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).toContain('<base href="/" />')
    }
    // A real dotfile of the build is still never served.
    const env = await app.inject({ method: 'GET', url: '/.env', headers: { ...H, accept: 'text/html' } })
    expect(env.body).not.toContain('hidden-file')
  })
})
