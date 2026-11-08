// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { Info } from 'lucide-vue-next'
import AboutView from '../src/about/AboutView.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useCommandsStore } from '../src/stores/commands'
import { paletteGroup, paletteIcon } from '../src/workspace/paletteGroups'
import { tabInputFromRoute, tabLocation } from '../src/workspace/tabRoutes'
import { tabIcon } from '../src/workspace/tabTitle'
import { APP_VERSION } from '../src/version'
import { mockApi, mountApp } from './support/app'

/** User request 2026-10-31: the About page — version, author, project, license, privacy. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const WEB = join(import.meta.dirname, '..')
const MANIFEST = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as { version: string }

function signedIn(mode: 'local' | 'team') {
  return mockApi({
    'GET auth/status': () => [200, { mode, setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode,
        user: { id: mode === 'local' ? 'local' : 'u2', username: 'ayse', role: 'readOnly' },
        // Nothing special is needed: everyone may open it.
        permissions: [],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, []],
  })
}

async function workspace(mode: 'local' | 'team', path = '/') {
  signedIn(mode)
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  return router
}

const page = () => document.querySelector<HTMLElement>('[data-about-page]')

describe('opening the About page', () => {
  it('is a tab of its own with an address', () => {
    expect(tabInputFromRoute({ name: 'about', params: {} })).toEqual({ kind: 'about', title: '' })
    expect(tabLocation({ id: 'about', kind: 'about', title: '', params: {} })).toEqual({ name: 'about' })
    expect(tabIcon('about')).toBe(Info)
  })

  it('opens from its address', async () => {
    await workspace('local', '/about')
    await vi.waitFor(() => expect(page()).not.toBeNull())
    expect(useTabsStore().active?.kind).toBe('about')
  })

  for (const mode of ['local', 'team'] as const)
    it(`opens from the account menu, in ${mode} mode, for a user with no rights`, async () => {
      const router = await workspace(mode)
      ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.trim() === 'About Mongo Manager')!
        .click()
      await vi.waitFor(() => expect(page()).not.toBeNull())
      expect(useTabsStore().active?.kind).toBe('about')
      expect(router.currentRoute.value.path).toBe('/about')
    })

  it('opens from the command palette, under Navigate', async () => {
    await workspace('team')
    const command = useCommandsStore().commands.find((c) => c.id === 'about')!
    expect(command).toBeDefined()
    expect(paletteGroup(command)).toBe('navigate')
    expect(paletteIcon(command)).toBe(Info)
    await command.run()
    await vi.waitFor(() => expect(page()).not.toBeNull())
    expect(useTabsStore().active?.kind).toBe('about')
  })
})

describe('the About page', () => {
  it('shows the version from the app’s own manifest', () => {
    mountApp(AboutView)
    expect(APP_VERSION).toBe(MANIFEST.version)
    // A release changes the manifest only: never a version written here (1.0.1 found it).
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(document.querySelector('[data-about-version]')!.textContent?.trim()).toBe(
      `Version ${MANIFEST.version}`,
    )
    expect(page()!.textContent).toContain('Mongo Manager')
    expect(page()!.textContent).toContain('A secure MongoDB manager in your browser')
  })

  it('names the author, with a mail link and their GitHub profile', () => {
    mountApp(AboutView)
    const author = document.querySelector<HTMLElement>('[data-about-author]')!
    expect(author.textContent).toContain('Gokhan OZGEZER')
    expect(author.querySelector('[data-about-link="email"]')!.getAttribute('href')).toBe(
      'mailto:gokhanozgezer@gmail.com',
    )
    expect(author.textContent).toContain('gokhanozgezer@gmail.com')
    expect(author.querySelector('[data-about-link="github"]')!.getAttribute('href')).toBe(
      'https://github.com/gokhanozgezer',
    )
  })

  it('links the project, its issues and its security policy', () => {
    mountApp(AboutView)
    const href = (id: string) => document.querySelector(`[data-about-link="${id}"]`)!.getAttribute('href')
    expect(href('repository')).toBe('https://github.com/mongo-manager/mongo-manager')
    expect(document.querySelector('[data-about-github]')!.getAttribute('href')).toBe(
      'https://github.com/mongo-manager/mongo-manager',
    )
    expect(href('issues')).toBe('https://github.com/mongo-manager/mongo-manager/issues')
    expect(href('security')).toBe('https://github.com/mongo-manager/mongo-manager/blob/main/SECURITY.md')
  })

  it('names the license, its three terms in plain words, and links it', () => {
    mountApp(AboutView)
    const license = document.querySelector<HTMLElement>('[data-about-license]')!
    expect(license.querySelector('[data-about-license-name]')!.textContent).toBe(
      'GNU Affero General Public License v3.0 only',
    )
    expect(license.textContent).toContain('AGPL-3.0-only')
    expect(
      [...license.querySelectorAll('[data-about-term]')].map((t) => t.getAttribute('data-about-term')),
    ).toEqual(['use', 'shareSource', 'notices'])
    expect(license.textContent).toContain('commercial use included')
    expect(license.textContent).toContain('THIRD-PARTY-NOTICES.txt')
    const href = (id: string) => license.querySelector(`[data-about-link="${id}"]`)!.getAttribute('href')
    expect(href('deed')).toBe('https://www.gnu.org/licenses/agpl-3.0.html')
    expect(href('license')).toBe('https://github.com/mongo-manager/mongo-manager/blob/main/LICENSE')
    expect(href('notice')).toBe('https://github.com/mongo-manager/mongo-manager/blob/main/NOTICE')
    expect(page()!.textContent).toContain('Free to use')
  })

  // User request 2026-11-03: the Appropriate Legal Notices of the AGPL, and NOTICE's terms, in every
  // language: the copyright and the attribution as NOTICE words them, and that there is no warranty.
  it('shows the copyright, the attribution and that there is no warranty', () => {
    mountApp(AboutView)
    const license = document.querySelector<HTMLElement>('[data-about-license]')!
    expect(license.querySelector('[data-about-copyright]')!.textContent).toBe(
      'Copyright (C) 2026 Gokhan OZGEZER',
    )
    expect(license.querySelector('[data-about-attribution]')!.textContent).toBe(
      'Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager',
    )
    expect(license.querySelector('[data-about-warranty]')!.textContent).toBe(
      'Mongo Manager comes with no warranty, to the extent the law allows.',
    )
    const notice = readFileSync(join(WEB, '..', '..', 'NOTICE'), 'utf8')
    expect(notice).toContain('"Copyright (C) 2026 Gokhan OZGEZER"')
    expect(notice).toContain(
      '"Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager"',
    )
  })

  it('says how it treats the network', async () => {
    mockApi({
      'GET updates': () => [
        200,
        {
          installed: '1.0.2',
          distribution: 'npm',
          disabled: false,
          launcher: true,
          auto: false,
          lastCheck: null,
          latest: null,
          offer: null,
          progress: null,
        },
      ],
    })
    mountApp(AboutView)
    await flushPromises()
    const privacy = document.querySelector<HTMLElement>('[data-about-privacy]')!.textContent
    expect(privacy).toContain('Works fully offline')
    expect(privacy).toContain('No telemetry')
    expect(privacy).toContain('No update checks')
  })

  // Abuse case: a link that opened in the app's own window could replace it (a web mail handling
  // mailto:), and one without noopener would hand the other site this window.
  it('opens every link in a new tab, without handing over the window', () => {
    mountApp(AboutView)
    const links = [...page()!.querySelectorAll('a')]
    expect(links.length).toBeGreaterThanOrEqual(8)
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^(https:\/\/|mailto:)/)
      expect(a.getAttribute('target')).toBe('_blank')
      const rel = (a.getAttribute('rel') ?? '').split(/\s+/)
      expect(rel).toContain('noopener')
      expect(rel).toContain('noreferrer')
    }
  })

  // Offline first: links point out, but the page loads nothing from another site. The updater
  // (2026-11-03): it asks its own server what that server last found — never GitHub itself.
  it('loads nothing from the network', () => {
    const { calls } = mockApi({})
    mountApp(AboutView)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET updates'])
    const loads = [...page()!.querySelectorAll('[src], [srcset], link, iframe, object, embed')]
    expect(loads).toEqual([])
    const styled = [...page()!.querySelectorAll<HTMLElement>('[style]')].filter((e) =>
      /url\(/i.test(e.getAttribute('style') ?? ''),
    )
    expect(styled).toEqual([])
  })

  it('reads in each language', async () => {
    for (const lang of ['tr', 'fr', 'ru', 'ja'] as const) {
      await import('../src/i18n').then((m) => m.setLocale(lang))
      mountApp(AboutView)
      const text = page()!.textContent ?? ''
      expect(text, lang).not.toContain('about.')
      expect(text, lang).toContain('Gokhan OZGEZER')
      document.body.innerHTML = ''
    }
    await import('../src/i18n').then((m) => m.setLocale('en'))
  })
})

describe('the About page’s words', () => {
  type Tree = { [key: string]: string | Tree }
  const DIR = join(WEB, 'src', 'i18n', 'locales')
  const LOCALES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru']
  const strings = (tree: Tree | string): string[] =>
    typeof tree === 'string' ? [tree] : Object.values(tree).flatMap(strings)
  /** "Open source" in each language: the product is never called so (user rule). */
  const FORBIDDEN = [
    /open[\s-]?source/i,
    /açık kaynak/i,
    /开源|開源/,
    /オープンソース/,
    /código abierto|código aberto/i,
    /오픈\s?소스/,
    /quelloffen/i,
    /logiciel libre/i,
    /открыт\S* исходн/i,
  ]

  for (const lang of LOCALES)
    it(`never call it open source (${lang})`, () => {
      const all = JSON.parse(readFileSync(join(DIR, `${lang}.json`), 'utf8')) as Tree
      const words = [
        ...strings(all.about!),
        (all.header as Tree).about as string,
        (all.tabs as Tree).about as string,
        ((all.palette as Tree).commands as Tree).about as string,
      ]
      expect(words.length).toBeGreaterThan(30)
      expect(words.filter((w) => FORBIDDEN.some((f) => f.test(w)))).toEqual([])
    })

  it('nor do the page’s own names and addresses', () => {
    for (const file of ['src/about/AboutView.vue', 'src/about/project.ts']) {
      const source = readFileSync(join(WEB, file), 'utf8')
      expect(
        FORBIDDEN.filter((f) => f.test(source)),
        file,
      ).toEqual([])
    }
  })
})
