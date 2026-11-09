// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import type { PluginAdminView } from '@mongo-manager/shared'
import PluginsView from '../src/admin/PluginsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { crc32, zipStored } from '../src/admin/zip'
import { STARTER_FILES, STARTER_FOLDER } from '../src/admin/pluginStarter'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp } from './support/app'
import { typeInto } from './support/dom'
import { LONG_METHODS, QUESTION_METHODS, QUESTION_TIMEOUT_MS } from '../../plugins/kit/src/client'

// User request 2026-10-11: people building a plugin get the guide, the starter and the instruction
// files for their AI assistant from the app, and administrators install a plugin from GitHub.
const STARTER = join(__dirname, '..', '..', 'plugins', 'starter')
/** The starter's own files: what a developer packed there (a .tgz) or installed is not its. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name !== 'node_modules' && !name.endsWith('.tgz'))
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? filesIn(path) : [relative(STARTER, path).split(sep).join('/')]
    })

/** The entries of a stored zip, read back from its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    expect(view.getUint16(at + 10, true)).toBe(0) // stored
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extra = view.getUint16(at + 30, true)
    const comment = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + size)
    expect(crc32(data)).toBe(crc)
    out.set(name, new TextDecoder().decode(data))
    at += 46 + nameLength + extra + comment
  }
  return out
}

describe('a stored zip', () => {
  it('computes CRC-32 as zip readers do', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('holds each file as it is, under its path, in UTF-8', () => {
    const zip = zipStored([
      { path: 'a/b.txt', data: new TextEncoder().encode('hello') },
      { path: 'a/ğ.md', data: new TextEncoder().encode('# Merhaba') },
    ])
    expect([...unzip(zip)]).toEqual([
      ['a/b.txt', 'hello'],
      ['a/ğ.md', '# Merhaba'],
    ])
  })
})

describe('the plugin starter', () => {
  it('is the starter folder, every file of it, hidden ones included', () => {
    expect(Object.keys(STARTER_FILES).sort()).toEqual(filesIn(STARTER).sort())
  })

  it('imports each file by name: the production build’s glob drops hidden files (found 2026-10-11)', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'admin', 'pluginStarter.ts'), 'utf8')
    expect(source).not.toContain('import.meta.glob')
    for (const path of filesIn(STARTER))
      expect(source, path).toContain(`from '../../../plugins/starter/${path}?raw'`)
  })
})

// User request 2026-10-30: an AI assistant building a plugin writes it in every language of the app,
// not only in English: the instruction files make all ten a rule, with what each language needs.
describe('the AI assistants’ instructions', () => {
  const LANGUAGES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru']
  const files = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']

  for (const file of files)
    it(`${file} asks for every text in all ten languages`, () => {
      const text = readFileSync(join(STARTER, ...file.split('/')), 'utf8')
      expect(text).toContain(LANGUAGES.join(', '))
      expect(text).toMatch(/all ten languages/)
      // No more "as many languages as you can": every language is a rule, not a wish.
      expect(text).not.toMatch(/as many/i)
      for (const rule of ['README.<lang>.md', 'Intl.PluralRules', 'U+202F', 'KB'])
        expect(text, `${file}: ${rule}`).toContain(rule)
    })

  // Starter review 2026-10-30: the starter's client gives up on a request when the kit does — a change
  // the user is asked about waits for the user, not 15 seconds — and its words follow its own rules.
  it('waits as the kit does, counts with the plural rules and says every refusal in every language', () => {
    const main = readFileSync(join(STARTER, 'main.js'), 'utf8')
    for (const method of QUESTION_METHODS) expect(main, method).toContain(`'${method}'`)
    expect(main).toContain(String(QUESTION_TIMEOUT_MS).replace(/(\d)(?=(\d{3})+$)/g, '$1_'))
    for (const [method, ms] of LONG_METHODS) {
      expect(main, method).toContain(`'${method}'`)
      expect(ms).toBe(12 * 3_600_000)
      expect(main, method).toContain('12 * 3_600_000')
    }
    expect(main).toContain('Intl.PluralRules')
    expect(main).not.toMatch(/n === 1 \?|n < 2 \?/)
    for (const code of ['read_only', 'not_found', 'unavailable', 'too_large', 'unanswered'])
      expect(main.match(new RegExp(`^ {6}${code}: '`, 'gm')), code).toHaveLength(10)
    // French puts a narrow no-break space before : ; ! ? in its words.
    const fr = main.slice(main.indexOf('\n  fr: {'), main.indexOf('\n  ru: {'))
    const words = [...fr.matchAll(/^ +\w+: '((?:[^'\\]|\\.)*)',$/gm)].map((m) => m[1]!)
    expect(words.length).toBeGreaterThan(20)
    expect(words.filter((w) => / [:;!?]/.test(w))).toEqual([])
    const manifest = readFileSync(join(STARTER, 'mongo-manager-plugin.json'), 'utf8')
    const french = [...manifest.matchAll(/"fr": "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
    expect(french.length).toBeGreaterThan(2)
    expect(french.filter((w) => /[ \u00a0][:;!?]/.test(w))).toEqual([])
  })

  it('says so on the Plugins page, where the files are downloaded', () => {
    expect(i18n.global.t('plugins.build.aiHint')).toMatch(/all ten of the app’s languages/)
  })
})

describe('building and installing plugins from the Plugins page', () => {
  const saved: Array<{ name: string; blob: Blob }> = []
  let lastBlob: Blob | null = null
  beforeEach(() => {
    saved.length = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((lastBlob = b as Blob), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.download && lastBlob) saved.push({ name: this.download, blob: lastBlob })
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    i18n.global.locale.value = 'en'
  })
  function page(github = true, extra: Record<string, () => [number, unknown]> = {}) {
    const api = mockApi({
      'GET plugins/manage': () => [200, { enabled: true, github, plugins: [] as PluginAdminView[] }],
      ...extra,
    })
    mountApp(PluginsView)
    mountApp(DialogHost)
    return api
  }
  const build = () => document.querySelector<HTMLElement>('[data-plugin-build]')!
  const buttonIn = (el: Element, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label))!

  it('links the developer guide in the reader’s language, opened apart', async () => {
    page()
    await flushPromises()
    const guide = build().querySelector<HTMLAnchorElement>('a[data-plugin-guide]')!
    expect(guide.getAttribute('href')).toBe('docs/plugins.html')
    expect(guide.target).toBe('_blank')
    expect(guide.rel).toBe('noopener noreferrer')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    expect(guide.getAttribute('href')).toBe('docs/tr/plugins.html')
  })

  it('downloads the starter as a zip of its folder', async () => {
    page()
    await flushPromises()
    buttonIn(build(), 'Download the starter').click()
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]!.name).toBe('mongo-manager-plugin-starter.zip')
    const entries = unzip(new Uint8Array(await saved[0]!.blob.arrayBuffer()))
    expect([...entries.keys()].sort()).toEqual(
      filesIn(STARTER)
        .map((p) => `${STARTER_FOLDER}/${p}`)
        .sort(),
    )
    expect(entries.get(`${STARTER_FOLDER}/mongo-manager-plugin.json`)).toBe(
      readFileSync(join(STARTER, 'mongo-manager-plugin.json'), 'utf8'),
    )
  })

  it('downloads each AI assistant’s instructions under the name it looks for', async () => {
    page()
    await flushPromises()
    for (const [label, name, file] of [
      ['Claude Code', 'CLAUDE.md', 'CLAUDE.md'],
      ['Codex', 'AGENTS.md', 'AGENTS.md'],
      ['Gemini', 'GEMINI.md', 'GEMINI.md'],
      ['GitHub Copilot', 'copilot-instructions.md', '.github/copilot-instructions.md'],
    ] as const) {
      saved.length = 0
      buttonIn(build(), label).click()
      await vi.waitFor(() => expect(saved, label).toHaveLength(1))
      expect(saved[0]!.name).toBe(name)
      expect(await saved[0]!.blob.text()).toBe(readFileSync(join(STARTER, ...file.split('/')), 'utf8'))
    }
  })

  // Review 2026-10-11 (minor 21): a save that fails says so.
  it('says when the starter could not be saved', async () => {
    page()
    await flushPromises()
    vi.mocked(URL.createObjectURL).mockImplementation(() => {
      throw new Error('blocked')
    })
    buttonIn(build(), 'Download the starter').click()
    await vi.waitFor(() =>
      expect(useToastStore().toasts.at(-1)?.message).toBe('The file could not be saved: blocked'),
    )
    buttonIn(build(), 'Claude Code').click()
    await vi.waitFor(() => expect(useToastStore().toasts.filter((t) => t.kind === 'error')).toHaveLength(2))
  })

  it('explains each new GitHub refusal', () => {
    const t = i18n.global.t
    expect(t('plugins.github.reasons.redirects')).toContain('too many times')
    expect(t('plugins.github.reasons.forbidden')).toContain('refused')
  })

  it('installs a plugin from a GitHub address, then says to approve it', async () => {
    const { calls } = page(true, {
      'POST plugins/github': () => [201, { id: 'hello', manifest: { name: { en: 'Hello' } } }],
    })
    await flushPromises()
    const form = document.querySelector<HTMLFormElement>('[data-plugin-github]')!
    await typeInto(form.querySelector('input')!, '  https://github.com/someone/hello  ')
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: 'plugins/github',
      body: { url: 'https://github.com/someone/hello' },
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Hello installed from GitHub. Review it, then approve it.',
    )
    expect(form.querySelector('input')!.value).toBe('')
  })

  it('says why GitHub could not help, in the user’s words', async () => {
    page(true, {
      'POST plugins/github': () => [
        404,
        { error: 'not_found', message: 'x', details: { reason: 'github_not_found' } },
      ],
    })
    await flushPromises()
    const form = document.querySelector<HTMLFormElement>('[data-plugin-github]')!
    await typeInto(form.querySelector('input')!, 'https://github.com/someone/hello')
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'That repository has no published release. Publish one with the plugin’s .tgz attached.',
    )
    // What was typed stays, to be corrected.
    expect(form.querySelector('input')!.value).toBe('https://github.com/someone/hello')
  })

  it('offers no GitHub install when the server turned it off', async () => {
    page(false)
    await flushPromises()
    expect(document.querySelector('[data-plugin-github]')).toBeNull()
    expect(build()).not.toBeNull()
  })
})
