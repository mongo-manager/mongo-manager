import { createHash } from 'node:crypto'
import { UI_LANGUAGES } from '@mongo-manager/shared'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'

/**
 * A built web app held in memory, as a standalone binary carries it: keys are `/`-separated paths
 * inside the build (`index.html`, `assets/app-x.js`).
 */
export type WebAssets = ReadonlyMap<string, Uint8Array>

/** Where the web app comes from: a build folder on disk, or an in-memory table. */
export type WebSource = { root: string } | { assets: WebAssets }

/** Built web app locations: next to the bundled server (1f), else the monorepo build. */
export function defaultWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'public'), join(here, '..', '..', '..', 'web', 'dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  avif: 'image/avif',
  otf: 'font/otf',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
}

function contentType(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 && TYPES[path.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'
}

/** Only Vite's content-hashed files may be cached forever; judged by the path inside the build. */
const cacheControl = (inside: string) =>
  inside.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'

/**
 * A path inside the build, or null. The router has already decoded it; anything that could step
 * outside the table or name a hidden file is refused rather than normalised.
 */
function assetKey(path: string): string | null {
  if (path === '' || path.includes('\\') || path.includes('\0')) return null
  const parts = path.split('/')
  return parts.every((p) => p !== '' && !p.startsWith('.')) ? path : null
}

function registerEmbedded(app: FastifyInstance, assets: WebAssets, basePath: string): void {
  // Content ETags, computed once per file on first use: revalidation gets a 304.
  const etags = new Map<string, string>()
  const etagOf = (key: string, body: Uint8Array) => {
    let tag = etags.get(key)
    if (!tag) {
      tag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
      etags.set(key, tag)
    }
    return tag
  }
  const serve = (request: FastifyRequest, reply: FastifyReply) => {
    const key = assetKey((request.params as { '*'?: string })['*'] ?? '')
    const body = key === null || key === 'index.html' ? undefined : assets.get(key)
    if (key === null || body === undefined) return reply.callNotFound()
    const etag = etagOf(key, body)
    reply
      .header('etag', etag)
      .header('cache-control', cacheControl(key))
      // Web assets are small and whole; partial requests are not offered.
      .header('accept-ranges', 'none')
    const match = request.headers['if-none-match']
    if (match && match.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return reply.code(304).send()
    }
    return reply.type(contentType(key)).send(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
  }
  // HEAD is answered by Fastify from the GET route, without a body.
  app.get(`${basePath}*`, serve)
}

/**
 * Serves the SPA under basePath. Returns index.html with <base href> rewritten to basePath (so
 * relative assets and API calls work behind any prefix), or null when no build exists.
 */
export async function registerWebApp(
  app: FastifyInstance,
  opts: WebSource & { basePath: string },
): Promise<string | null> {
  let raw: string
  if ('assets' in opts) {
    const index = opts.assets.get('index.html')
    if (!index) return null
    raw = new TextDecoder().decode(index)
  } else {
    const indexPath = join(opts.root, 'index.html')
    if (!existsSync(indexPath)) return null
    raw = readFileSync(indexPath, 'utf8')
  }
  const html = raw.replace(/<base href="[^"]*"\s*\/?>/, `<base href="${opts.basePath}" />`)
  if ('assets' in opts) {
    registerEmbedded(app, opts.assets, opts.basePath)
  } else {
    const root = opts.root
    await app.register(fastifyStatic, {
      root,
      prefix: opts.basePath,
      index: false,
      // A hidden file is treated as missing: never served, and a deep link whose name starts
      // with a dot still opens the app (final review 1g-2, Minor 12).
      dotfiles: 'ignore',
      setHeaders: (reply, filePath) => {
        reply.header('cache-control', cacheControl(relative(root, filePath).split(sep).join('/')))
      },
    })
  }
  const sendIndex = (_request: unknown, reply: FastifyReply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html)
  app.get(opts.basePath, sendIndex)
  // The raw file carries <base href="/">; always answer with the rewritten copy.
  app.get(`${opts.basePath}index.html`, sendIndex)
  if (opts.basePath !== '/') {
    const bare = opts.basePath.slice(0, -1)
    app.get(bare, (_request, reply) => reply.redirect(opts.basePath, 308))
  }
  // The offline docs (spec §3.6) start at docs/index.html; static serving lists no folders.
  const hasDocs =
    'assets' in opts ? opts.assets.has('docs/index.html') : existsSync(join(opts.root, 'docs', 'index.html'))
  if (hasDocs) {
    // Languages (review, minor 2): each language of the app has its folder of docs.
    for (const folder of ['docs', ...UI_LANGUAGES.filter((l) => l !== 'en').map((l) => `docs/${l}`)]) {
      const to = (_request: unknown, reply: FastifyReply) =>
        reply.redirect(`${opts.basePath}${folder}/index.html`, 302)
      app.get(`${opts.basePath}${folder}`, to)
      app.get(`${opts.basePath}${folder}/`, to)
    }
  }
  return html
}
