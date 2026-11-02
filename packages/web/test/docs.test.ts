import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import en from '../src/i18n/locales/en.json'
import { UI_LANGUAGES } from '@mongo-manager/shared/browser'
import { SHORTCUT_GROUPS } from '../src/workspace/shortcuts'

const DOCS = join(import.meta.dirname, '..', 'public', 'docs')
const pages = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
const html = (path: string) => readFileSync(path, 'utf8')
/** Languages (2026-10-29): a folder a language, beside the English pages; html lang is its tag. */
const FOLDERS = readdirSync(DOCS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
const TAG: Record<string, string> = { zh: 'zh-CN', pt: 'pt-BR' }
const all = [
  ...pages(DOCS).map((f) => ({ path: join(DOCS, f), lang: 'en', folder: 'en' })),
  ...FOLDERS.flatMap((l) =>
    pages(join(DOCS, l)).map((f) => ({ path: join(DOCS, l, f), lang: TAG[l] ?? l, folder: l })),
  ),
]
/** A page in English and in every language folder. */
const everywhere = (page: string) => [page, ...FOLDERS.map((l) => join(l, page))]
const messagesOf = (lang: string) =>
  lang === 'en'
    ? en
    : (JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'src', 'i18n', 'locales', `${lang}.json`), 'utf8'),
      ) as typeof en)

describe('offline docs at /docs (phase 1g-2, Review Focus 4)', () => {
  it('have the same pages in English and Turkish', () => {
    expect(pages(DOCS)).toEqual([
      'ai.html',
      'backup.html',
      'deployment.html',
      'getting-started.html',
      'import-export.html',
      'index.html',
      'plugins.html',
      'security.html',
      // W3: users and roles, sharding, alerts and live health.
      'server-admin.html',
      'shortcuts.html',
      'sync.html',
      'watch.html',
    ])
    // Every language the app offers has its docs, and only those.
    const offered = readdirSync(join(import.meta.dirname, '..', 'src', 'i18n', 'locales'))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((l) => l !== 'en')
      .sort()
    expect(FOLDERS).toEqual(offered)
    for (const l of FOLDERS) expect(pages(join(DOCS, l)), l).toEqual(pages(DOCS))
  })

  it('are plain documents: language, title, one stylesheet, no script, style or event handler', () => {
    for (const { path, lang } of all) {
      const text = html(path)
      const name = relative(DOCS, path)
      expect(text.startsWith('<!doctype html>'), name).toBe(true)
      expect(text, name).toContain(`<html lang="${lang}">`)
      expect(text, name).toMatch(/<title>[^<]+<\/title>/)
      expect(text, name).toMatch(/<link rel="stylesheet" href="(\.\.\/)?docs\.css" \/>/)
      expect(text, name).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i)
    }
  })

  it('link only to pages that exist, relatively', () => {
    for (const { path } of all) {
      for (const [, url] of html(path).matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        expect(url, `${relative(DOCS, path)}: ${url}`).not.toMatch(/^([a-z][a-z0-9+.-]*:|\/)/i)
        const file = join(dirname(path), url!.split('#')[0]!)
        expect(existsSync(file), `${relative(DOCS, path)} → ${url}`).toBe(true)
      }
    }
  })

  // Review of the languages (minor 7): every page names the language group, shows its own language,
  // and links itself in every other one, in the app's order.
  it('link every page to itself in every other language, its own shown', () => {
    const order = UI_LANGUAGES.filter((l) => l === 'en' || FOLDERS.includes(l))
    for (const { path, folder } of all) {
      const bar =
        /<span class="langs" role="group" aria-label="[^"]+">([\s\S]*?)<\/span>/.exec(html(path))?.[1] ?? ''
      const items = [...bar.matchAll(/<(a|strong) lang="([^"]+)"(?: hreflang="[^"]+" href="([^"]+)")?>/g)]
      const name = relative(DOCS, path)
      expect(
        items.map((m) => m[2]),
        name,
      ).toEqual(order.map((l) => TAG[l] ?? l))
      expect(
        items.filter((m) => m[1] === 'strong').map((m) => m[2]),
        name,
      ).toEqual([TAG[folder] ?? folder])
      const page = name.split(sep).at(-1)!
      for (const m of items.filter((x) => x[1] === 'a'))
        expect(m[3], name).toMatch(new RegExp(`(^|/)${page.replace('.', '\\.')}$`))
    }
  })

  // Docs redesign (user request 2026-10-30): the guides beside the text, a language menu on top, the
  // page's sections listed beside it, and tables that never break their words letter by letter.
  it('lay every page out the same way: the product, a language menu, the guides and the sections', () => {
    const tocTitles = new Set<string>()
    for (const { path } of all) {
      const text = html(path)
      const name = relative(DOCS, path)
      const own = /<strong lang="[^"]+">([^<]+)<\/strong>/.exec(text)?.[1]
      expect(text, name).toMatch(
        /<header>\s*<a class="brand" href="index\.html">[^<]+<\/a>\s*<details class="lang-menu">/,
      )
      expect(text, name).toContain(`<summary>${own}</summary>`)
      // The guides: a nav of the body, every page, this one shown.
      const nav = /\n {4}<nav>([\s\S]*?)\n {4}<\/nav>\n {4}<main>/.exec(text)?.[1] ?? ''
      expect([...nav.matchAll(/href="([^"]+)"/g)].length + 1, name).toBe(pages(DOCS).length)
      expect(nav.match(/<strong>/g), name).toHaveLength(1)
      // Every section has an id, and the side list names each, in order.
      const ids = [...text.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1])
      expect(ids.length, name).toBe((text.match(/<h2[\s>]/g) ?? []).length)
      const toc =
        /<aside class="toc" aria-labelledby="toc-title">\s*<p id="toc-title">([^<]+)<\/p>([\s\S]*?)<\/aside>/.exec(
          text,
        )
      if (ids.length < 2) expect(toc, name).toBeNull()
      else {
        tocTitles.add(toc![1]!)
        expect(
          [...toc![2]!.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]),
          name,
        ).toEqual(ids)
      }
      // Tables scroll inside the text.
      expect((text.match(/<table/g) ?? []).length, name).toBe(
        (text.match(/<div class="table">\s*<table/g) ?? []).length,
      )
    }
    // "On this page" in each language.
    expect(tocTitles.size).toBe(FOLDERS.length + 1)
    // A section keeps its id in every language, so a link to it works in all of them.
    for (const page of pages(DOCS)) {
      const ids = (p: string) => [...html(join(DOCS, p)).matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1])
      for (const p of everywhere(page).slice(1)) expect(ids(p), p).toEqual(ids(page))
    }
    const css = readFileSync(join(DOCS, 'docs.css'), 'utf8')
    // What made a column of a reference table break letter by letter, and the one narrow card.
    expect(css).not.toMatch(/overflow-wrap:\s*anywhere/)
    expect(css).not.toMatch(/max-width:\s*48rem/)
  })

  // The Russian docs are written as the app is: with е, never ё (the menu named the same page twice).
  it('write Russian with е, as the app does', () => {
    for (const page of pages(join(DOCS, 'ru'))) expect(html(join(DOCS, 'ru', page)), page).not.toMatch(/[ёЁ]/)
  })

  // Starter review 2026-10-30: the plugin guide says what the app does, in every language.
  it('tell plugin builders the ten locales, every way a dialog closes, and every Function the scan reads', () => {
    for (const page of everywhere('plugins.html')) {
      const text = html(join(DOCS, page))
      const locale = /<li><code>locale<\/code>[\s\S]*?<\/li>/.exec(text)?.[0] ?? ''
      for (const lang of UI_LANGUAGES) expect(locale, `${page} ${lang}`).toContain(`<code>${lang}</code>`)
      const action = text.slice(text.indexOf('<td><code>documentActions</code></td>'))
      expect(action.slice(0, action.indexOf('</tr>')), page).toContain('<code>ui.useQueryIn</code>')
      for (const way of ['globalThis.', 'Function.call(', 'Reflect.construct(Function', "['Function']"])
        expect(text, `${page} ${way}`).toContain(way)
    }
  })

  it('link the Watch guide from every page, with the anchor the app links to (phase 3e-1)', () => {
    for (const { path } of all) {
      const text = html(path)
      const name = relative(DOCS, path)
      if (name.endsWith('watch.html')) {
        expect(text, name).toContain('id="pre-images"')
        // Final review M5, M6: the anchor the dead ends link to; "from now" never as "şimdiden".
        expect(text, name).toContain('id="requirements"')
        expect(text, name).not.toMatch(/şimdiden/i)
        expect(text, name).toContain('changeStreamPreAndPostImages')
        expect(text, name).toMatch(/<nav>[\s\S]*<strong>[^<]+<\/strong>[\s\S]*<\/nav>/)
      } else expect(text, name).toMatch(/<nav>[\s\S]*href="watch\.html"[\s\S]*<\/nav>/)
    }
    for (const page of everywhere('deployment.html')) {
      const text = html(join(DOCS, page))
      expect(text, page).toContain('MM_WATCH')
      expect(text, page).toContain('MM_WATCH_MAX_FEEDS')
    }
    for (const page of everywhere('security.html'))
      expect(html(join(DOCS, page)), page).toContain('id="watch"')
  })

  it('link the Live sync guide from every page, and document its settings and security (phase 3e-2)', () => {
    for (const { path } of all) {
      const text = html(path)
      const name = relative(DOCS, path)
      if (name.endsWith('sync.html')) {
        for (const id of [
          'requirements',
          'start',
          'oplog',
          'applying',
          'verify',
          'finish',
          'states',
          'personal-data',
          'limits',
        ])
          expect(text, `${name} #${id}`).toContain(`id="${id}"`)
        expect(text, name).toMatch(/<nav>[\s\S]*<strong>[^<]+<\/strong>[\s\S]*<\/nav>/)
        expect(text, name).not.toMatch(/şimdiden/i)
      } else expect(text, name).toMatch(/<nav>[\s\S]*href="sync\.html"[\s\S]*<\/nav>/)
    }
    for (const page of everywhere('deployment.html')) {
      const text = html(join(DOCS, page))
      expect(text, page).toContain('id="live-sync"')
      expect(text, page).toContain('MM_LIVE_SYNC')
      expect(text, page).toContain('MM_LIVE_SYNC_MAX')
    }
    for (const page of everywhere('security.html'))
      expect(html(join(DOCS, page)), page).toContain('id="live-sync"')
  })

  it('link the AI assistant guide from every page, and document its settings and security (phase 4a-1)', () => {
    for (const { path } of all) {
      const text = html(path)
      const name = relative(DOCS, path)
      if (name.endsWith('ai.html')) {
        for (const id of [
          'actions',
          'providers',
          'offline',
          'what-is-sent',
          'personal-data',
          'policy',
          'limits',
          'safety',
          'chat',
        ])
          expect(text, `${name} #${id}`).toContain(`id="${id}"`)
        expect(text, name).toMatch(/<nav>[\s\S]*<strong>[^<]+<\/strong>[\s\S]*<\/nav>/)
      } else expect(text, name).toMatch(/<nav>[\s\S]*href="ai\.html"[\s\S]*<\/nav>/)
    }
    for (const page of everywhere('deployment.html')) {
      const text = html(join(DOCS, page))
      expect(text, page).toContain('id="ai"')
      for (const v of [
        'MM_AI',
        'MM_AI_PRIVATE_NETWORKS',
        'MM_AI_PER_MINUTE',
        'MM_AI_PER_DAY',
        'MM_AI_MAX_CONCURRENT',
        'MM_AI_CHAT_DAYS',
      ])
        expect(text, `${page} ${v}`).toContain(v)
    }
    for (const page of everywhere('security.html')) expect(html(join(DOCS, page)), page).toContain('id="ai"')
    // Phase 4a-2: chats are stored, so no page may still say prompts and answers never are; Gemini is a provider.
    for (const page of ['ai.html', 'security.html']) {
      expect(html(join(DOCS, page)), page).not.toMatch(/Prompts and answers are not stored/)
      expect(html(join(DOCS, 'tr', page)), `tr/${page}`).not.toMatch(/İstemler ve yanıtlar saklanmaz/)
    }
    for (const page of everywhere('ai.html')) {
      const text = html(join(DOCS, page))
      expect(text, page).toContain('Gemini')
      expect(text, page).toContain('MM_AI_CHAT_DAYS')
    }
  })

  it('list every keyboard shortcut the app has, in every language', () => {
    for (const [lang, messages, file] of [
      ['en', en, join(DOCS, 'shortcuts.html')] as const,
      ...FOLDERS.map((l) => [l, messagesOf(l), join(DOCS, l, 'shortcuts.html')] as const),
    ]) {
      const text = html(file)
      for (const group of SHORTCUT_GROUPS)
        for (const item of group.items) {
          const label = (messages.shortcuts.actions as Record<string, string>)[item.action]!
          expect(text, `${lang}: ${item.action}`).toContain(label)
        }
    }
  })

  // Gap scan 2026-10-15: MM_METRICS_TOKEN, MM_GRIDFS_MAX_MB, MM_REQUIRE_ADMIN_2FA and the variables
  // behind the command-line options were named on no page.
  it('name every environment variable the server reads, in every language', () => {
    const root = join(import.meta.dirname, '..', '..')
    const sources = [
      readFileSync(join(root, 'server', 'src', 'config.ts'), 'utf8'),
      readFileSync(join(root, 'cli', 'src', 'args.ts'), 'utf8'),
    ].join('\n')
    // MM_WEB_ROOT serves a development build of the web app; nobody running a release needs it.
    const vars = [...new Set([...sources.matchAll(/\b(MM_[A-Z0-9_]+)\b/g)].map((m) => m[1]!))]
      .filter((v) => v !== 'MM_WEB_ROOT')
      .sort()
    expect(vars.length).toBeGreaterThan(40)
    for (const lang of ['en', ...FOLDERS]) {
      const text = all
        .filter((p) => p.folder === lang)
        .map((p) => html(p.path))
        .join('\n')
      expect(
        vars.filter((v) => !new RegExp(`\\b${v}\\b`).test(text)),
        lang,
      ).toEqual([])
    }
  })

  // UI redesign R2–R5 §5 (R5): the docs look like the app — its colours in light and dark (by the
  // reader's system setting: a static page has no stored theme), its typeface and its mark.
  it('follow the app’s look: its colours in light and dark, Inter, and the product mark', () => {
    const css = readFileSync(join(DOCS, 'docs.css'), 'utf8')
    const app = readFileSync(join(import.meta.dirname, '..', 'src', 'assets', 'main.css'), 'utf8')
    const block = (text: string, opener: RegExp) => {
      const start = text.search(opener)
      expect(start, String(opener)).toBeGreaterThanOrEqual(0)
      return text.slice(start, text.indexOf('}', start))
    }
    const value = (text: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(text)?.[1]
    const lightApp = block(app, /^:root \{/m)
    const darkApp = block(app, /^\.dark \{/m)
    const lightDocs = block(css, /^:root \{/m)
    const darkDocs = block(css, /prefers-color-scheme: dark\) \{\s*:root \{/)
    for (const name of [
      'ds-canvas',
      'ds-surface',
      'ds-subtle',
      'ds-line',
      'ds-fg',
      'ds-fg-muted',
      'ds-accent-fg',
      'ds-focus',
    ]) {
      expect(value(lightDocs, name), `light ${name}`).toBe(value(lightApp, name))
      expect(value(darkDocs, name), `dark ${name}`).toBe(value(darkApp, name))
    }
    expect(css).toMatch(/font-family:\s*'Inter Variable',\s*'Inter'/)
    expect(css).toMatch(/\.brand::before \{[^}]*url\('\.\.\/favicon\.svg'\)/)
    expect(existsSync(join(DOCS, '..', 'favicon.svg'))).toBe(true)
  })

  it('are all under docs/ in the build (nothing else ships in public/docs)', () => {
    const files = readdirSync(DOCS, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(DOCS, join(e.parentPath, e.name)).split(sep).join('/'))
    for (const f of files) expect(f, f).toMatch(/^([a-z]{2}\/)?[a-z-]+\.html$|^docs\.css$/)
  })
})
