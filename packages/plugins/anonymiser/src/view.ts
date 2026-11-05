// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  formatNumber,
  langTag,
  languageOf,
  pick,
  shown,
  h,
  pageHeader,
  setBusy,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { shapeOf } from '../../kit/src/shape'
import { MAX_CHARS, MESSAGE_BYTES, sentSize } from '../../mock-data/src/generate'
import {
  FAKE_KINDS,
  HIDDEN_TECHNIQUES,
  ID_KINDS,
  ID_TECHNIQUES,
  MAX_DAYS,
  TECHNIQUES,
  anonymise,
  loadSettings,
  plansOf,
  settingsText,
  type FakeKind,
  type FieldPlan,
  type Technique,
  type Unseen,
} from './anon'
import { TEXT, type Text } from './text'

/**
 * Plugins wave 4 (spec §1): an anonymised copy of the tab's collection — a technique for each field
 * of its sampled shape, five documents before and after, then up to 1,000 documents (and what one
 * message carries) read by _id pages, anonymised in the page, saved as NDJSON or JSON or handed to
 * the app's Import wizard for a new collection, where the user decides. The settings are saved and
 * loaded as JSON. The collection itself is never changed.
 */
type Doc = Record<string, unknown>
const SAMPLE = 100
const PREVIEW = 5
const PAGE = 200
export const MAX_DOCS = 1000

export interface MountOptions {
  /** The fake values' seed (tests pass their own). */
  seed?: number
  /** At most this many bytes go in one message (tests pass smaller). */
  maxBytes?: number
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!
const randomSalt = () => crypto.getRandomValues(new Uint8Array(32))

/** An _id's kind as $type names it (numbers are one: MongoDB compares them together). */
export function kindOfId(v: unknown): string | null {
  if (v === undefined) return null
  if (v === null) return 'null'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (Array.isArray(v)) return 'array'
  if (typeof v !== 'object') return null
  const keys = Object.keys(v)
  const one = keys.length === 1 ? keys[0] : null
  if (one && ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'].includes(one)) return 'number'
  if (one === '$oid') return 'objectId'
  if (one === '$date') return 'date'
  if (one === '$binary' || one === '$uuid') return 'binData'
  if (one === '$timestamp') return 'timestamp'
  if (one === '$minKey') return 'minKey'
  if (one === '$maxKey') return 'maxKey'
  if (one === '$regularExpression') return 'regex'
  return 'object'
}

/** A byte size in the app's units (B, KB, MB), its number formatted in the language shown. */
export function formatBytes(bytes: number, lang: string): string {
  if (bytes < 1024) return `${formatNumber(bytes, lang, 0)} B`
  const kb = bytes / 1024
  // Rounded to a whole 1,024 KB it reads as the next unit.
  if (Math.round(kb) < 1024) return `${formatNumber(kb, lang, kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${formatNumber(mb, lang, mb < 10 ? 1 : 0)} MB`
}

export function mount(root: HTMLElement, client: PluginClient, options: MountOptions = {}): void {
  const maxBytes = Math.min(options.maxBytes ?? MESSAGE_BYTES, MESSAGE_BYTES)
  let locale = 'en'
  let text: Text = pick(TEXT, locale)
  let ctx: PluginContext | null = null
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' | 'view' = 'reading'
  let failure: unknown = null
  let sample: Doc[] = []
  let plans: FieldPlan[] = []
  let unseen: Unseen = 'remove'
  let seed = options.seed ?? randomSeed()
  let salt = randomSalt()
  const now = Date.now()
  let count = String(MAX_DOCS)
  let target = ''
  let targetProblem = ''
  let copy: { docs: Doc[]; ndjson: string } | null = null
  let preparing = false

  const fileInput = h('input', {
    id: 'load-file',
    class: 'mm-sr',
    attrs: { type: 'file', accept: '.json,application/json', tabindex: '-1' },
  })
  const saveButton = button({
    label: text.save,
    icon: 'download',
    id: 'save',
    onClick: () => void saveSettings(),
  })
  const loadButton = button({
    label: text.load,
    icon: 'upload',
    id: 'load',
    onClick: () => fileInput.click(),
  })
  const header = pageHeader({ icon: 'shapes', title: '', description: '', actions: [loadButton, saveButton] })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body an-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, fileInput, body))

  const hidden = () => ctx?.place?.hidden ?? []
  /** The language the words (and so the page mark and the numbers) are really in. */
  const shownLang = () => shown(TEXT, locale)
  const run = (docs: Doc[]) =>
    anonymise(structuredClone(docs), plans, {
      seed,
      salt,
      hidden: hidden(),
      unseen,
      lang: languageOf(locale),
      now,
    })
  const say = (s: string) => (status.textContent = s)
  const sizeText = (bytes: number) => formatBytes(bytes, shownLang())
  const changed = () => {
    copy = null
    render()
  }

  async function saveSettings(): Promise<void> {
    if (!ctx?.place) return
    try {
      await client.ask('ui.download', {
        name: `${ctx.place.coll}-anonymiser`,
        type: 'json',
        text: settingsText(plans, unseen),
      })
    } catch (e) {
      say(askMessage(e, locale))
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    const loaded = file.size > 1_000_000 ? ({ ok: false } as const) : loadSettings(await file.text(), plans)
    if (!loaded.ok) return void say(text.badSettings)
    plans = loaded.plans
    unseen = loaded.unseen
    say(text.loaded(loaded.unknown))
    changed()
  })

  /** Reads the collection by _id pages (skip is never used), up to the count. */
  async function prepare(): Promise<void> {
    const wanted = Number(count)
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_DOCS) return void say(text.badCount)
    preparing = true
    copy = null
    render()
    const read: Doc[] = []
    try {
      // Final review Minor 10: MongoDB's $gt reads only _ids of its own kind — when one kind is read
      // through, the next kinds (in MongoDB's sort order) are read from their start.
      let last: unknown = undefined
      const done: string[] = []
      while (read.length < wanted) {
        say(text.preparing(read.length))
        const limit = Math.min(PAGE, wanted - read.length)
        const filter =
          last !== undefined
            ? { filter: { _id: { $gt: last } } }
            : done.length
              ? { filter: { _id: { $not: { $type: [...done] } } } }
              : {}
        const page = (
          await client.ask<{ documents: Doc[] }>('documents.find', { ...filter, sort: { _id: 1 }, limit })
        ).documents
        read.push(...page)
        if (page.length === limit) {
          last = page.at(-1)?._id
          if (last === undefined) break
          continue
        }
        // A short page with no $gt: all that is left was read. With a $gt: its kind is read through —
        // every kind met so far is (they come in order); the next kinds, if any, from their start.
        if (last === undefined) break
        for (const d of read) {
          const kind = kindOfId(d._id)
          if (kind && !done.includes(kind)) done.push(kind)
        }
        if (done.length >= 16) break
        last = undefined
      }
      const docs = run(read)
      // What one message carries: whole documents only.
      const lines: string[] = []
      let size = 2
      for (const d of docs) {
        const line = JSON.stringify(d) + '\n'
        const grown = size + sentSize(line) - 2
        if (grown > maxBytes || lines.join('').length + line.length > MAX_CHARS) break
        lines.push(line)
        size = grown
      }
      const kept = docs.slice(0, lines.length)
      copy = { docs: kept, ndjson: lines.join('') }
      say(
        kept.length < docs.length
          ? text.cut(kept.length)
          : text.prepared(kept.length, sizeText(new TextEncoder().encode(copy.ndjson).length)),
      )
    } catch (e) {
      say(askMessage(e, locale))
    } finally {
      preparing = false
    }
    render()
  }

  async function download(kind: 'ndjson' | 'json'): Promise<void> {
    if (!copy || !ctx?.place) return
    try {
      await client.ask('ui.download', {
        name: `${ctx.place.coll}-anonymised`,
        type: kind,
        text: kind === 'ndjson' ? copy.ndjson : JSON.stringify(copy.docs),
      })
    } catch (e) {
      say(askMessage(e, locale))
    }
  }

  async function importCopy(): Promise<void> {
    if (!copy || !ctx?.place) return
    const name = target.trim()
    targetProblem =
      name === ctx.place.coll
        ? text.sameTarget
        : !name ||
            name.length > 120 ||
            name.includes('$') ||
            name.startsWith('system.') ||
            name.includes('\0')
          ? text.badTarget
          : ''
    if (targetProblem) return void render()
    render()
    try {
      await client.ask('ui.importDocuments', { ndjson: copy.ndjson, coll: name })
    } catch (e) {
      say(askMessage(e, locale))
    }
  }

  function techniqueSelect(plan: FieldPlan, n: number): HTMLSelectElement {
    const offered = plan.hidden ? HIDDEN_TECHNIQUES : plan.path === '_id' ? ID_TECHNIQUES : TECHNIQUES
    const el = h('select', {
      id: `technique-${n}`,
      class: 'mm-select',
      data: { technique: '' },
      attrs: { 'aria-label': `${text.technique}: ${plan.path}` },
    })
    for (const t of offered) el.append(h('option', { attrs: { value: t }, text: text.techniques[t] }))
    el.value = plan.technique
    el.addEventListener('change', () => {
      plan.technique = el.value as Technique
      changed()
    })
    return el
  }

  function optionsOf(plan: FieldPlan, n: number): HTMLElement | null {
    const number = (
      value: number,
      min: number,
      max: number,
      on: (n: number) => void,
      data: string,
      label: string,
    ) => {
      const el = h('input', {
        // Final review Minor 12: an id, so a redraw gives the focus back.
        id: `${data}-${n}`,
        class: 'mm-input an-number',
        data: { [data]: '' },
        attrs: {
          type: 'number',
          min: String(min),
          max: String(max),
          step: '1',
          value: String(value),
          'aria-label': label,
        },
      })
      el.addEventListener('change', () => {
        const n = Number(el.value)
        if (Number.isFinite(n) && n >= min && n <= max) {
          on(n)
          changed()
        } else el.value = String(value)
      })
      return h('label', { class: 'an-option' }, h('span', { text: label }), el)
    }
    if (plan.technique === 'fake') {
      const el = h('select', {
        id: `kind-${n}`,
        class: 'mm-select',
        data: { kind: '' },
        attrs: { 'aria-label': text.kindOf(plan.path) },
      })
      for (const k of plan.path === '_id' ? ID_KINDS : FAKE_KINDS)
        el.append(h('option', { attrs: { value: k }, text: text.kinds[k] }))
      el.value = plan.kind
      el.addEventListener('change', () => {
        plan.kind = el.value as FakeKind
        changed()
      })
      return el
    }
    if (plan.technique === 'shift')
      return number(plan.days, 1, MAX_DAYS, (n) => (plan.days = n), 'days', text.days)
    if (plan.technique === 'noise')
      return number(plan.percent, 1, 100, (n) => (plan.percent = n), 'percent', text.percent)
    return null
  }

  function fieldsView(): HTMLElement {
    const rows = plans.map((plan, n) => {
      const tr = h(
        'tr',
        {},
        h(
          'td',
          {},
          h('span', { class: 'mm-mono', text: plan.path }),
          plan.hidden ? badge(text.hidden, 'warning') : null,
          plan.scalarOnly ? badge(text.scalarOnly, 'info') : null,
        ),
        h('td', { class: 'an-muted', text: plan.types.slice(0, 2).join(', ') }),
        h('td', {}, techniqueSelect(plan, n)),
        h('td', {}, optionsOf(plan, n)),
      )
      tr.dataset.field = plan.path
      return tr
    })
    const unseenSelect = h('select', { id: 'unseen', class: 'mm-select' })
    for (const u of ['remove', 'keep'] as const)
      unseenSelect.append(h('option', { attrs: { value: u }, text: text.unseens[u] }))
    unseenSelect.value = unseen
    unseenSelect.addEventListener('change', () => {
      unseen = unseenSelect.value as Unseen
      changed()
    })
    return h(
      'section',
      { class: 'an-section', attrs: { 'aria-label': text.fields } },
      h('h2', { class: 'an-title', text: text.fields }),
      h('p', { class: 'an-muted', text: text.hint }),
      h(
        'div',
        { class: 'an-table' },
        h(
          'table',
          { id: 'fields', class: 'mm-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...[text.field, text.type, text.technique, text.options].map((l) =>
                h('th', { attrs: { scope: 'col' }, text: l }),
              ),
            ),
          ),
          h('tbody', {}, ...rows),
        ),
      ),
      h('label', { class: 'an-option' }, h('span', { text: text.unseen }), unseenSelect),
    )
  }

  function previewView(): HTMLElement {
    const before = sample.slice(0, PREVIEW)
    const after = run(before)
    const reseed = button({
      label: text.reseed,
      icon: 'refresh',
      size: 'sm',
      id: 'reseed',
      onClick: () => {
        seed = randomSeed()
        salt = randomSalt()
        changed()
      },
    })
    return h(
      'section',
      { class: 'an-section', attrs: { 'aria-label': text.preview } },
      h('div', { class: 'an-head' }, h('h2', { class: 'an-title', text: text.preview }), reseed),
      h(
        'div',
        { id: 'preview', class: 'an-preview' },
        h('span', { class: 'an-muted', text: text.before }),
        h('span', { class: 'an-muted', text: text.after }),
        ...before.flatMap((d, i) => [
          h('pre', { class: 'an-doc mm-mono', data: { before: '' }, text: JSON.stringify(d, null, 2) }),
          h('pre', { class: 'an-doc mm-mono', data: { after: '' }, text: JSON.stringify(after[i], null, 2) }),
        ]),
      ),
    )
  }

  function outputView(): HTMLElement {
    const countInput = h('input', {
      id: 'count',
      class: 'mm-input an-number',
      attrs: { type: 'number', min: '1', max: String(MAX_DOCS), value: count },
    })
    countInput.addEventListener('input', () => {
      count = countInput.value
      // Final review Minor 12: a copy of another count is made again.
      if (copy) changed()
    })
    const go = button({
      label: text.prepare,
      icon: 'play',
      variant: 'primary',
      id: 'prepare',
      onClick: () => void prepare(),
    })
    setBusy(go, preparing)
    const ndjson = button({
      label: text.downloadNdjson,
      icon: 'download',
      id: 'download-ndjson',
      onClick: () => void download('ndjson'),
    })
    const json = button({
      label: text.downloadJson,
      icon: 'download',
      id: 'download-json',
      onClick: () => void download('json'),
    })
    const targetInput = h('input', {
      id: 'target',
      class: 'mm-input',
      attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'target-error' },
    })
    targetInput.value = target
    targetInput.addEventListener('input', () => (target = targetInput.value))
    const into = button({
      label: text.import,
      icon: 'upload',
      id: 'import',
      onClick: () => void importCopy(),
    })
    for (const b of [ndjson, json, into]) b.disabled = !copy || preparing
    return h(
      'section',
      { class: 'an-section', attrs: { 'aria-label': text.output } },
      h('h2', { class: 'an-title', text: text.output }),
      h(
        'div',
        { class: 'an-row' },
        h('label', { class: 'an-option' }, h('span', { text: text.count }), countInput),
        go,
      ),
      h('div', { class: 'an-row' }, ndjson, json),
      h(
        'div',
        { class: 'an-row' },
        h('label', { class: 'an-option' }, h('span', { text: text.target }), targetInput),
        into,
      ),
      h('p', { id: 'target-error', class: 'an-error', attrs: { role: 'alert' } }, targetProblem),
    )
  }

  function render(): void {
    const focusedId = (document.activeElement as HTMLElement | null)?.id
    text = pick(TEXT, locale)
    document.documentElement.lang = langTag(shownLang())
    header.setText(text.title, ctx?.place ? text.description(ctx.place.coll) : '')
    saveButton.querySelector('span')!.textContent = text.save
    loadButton.querySelector('span')!.textContent = text.load
    saveButton.hidden = loadButton.hidden = phase !== 'ready'
    body.replaceChildren()
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'shapes', title: text.noPlace }))
    if (phase === 'view') return void body.append(emptyState({ icon: 'shapes', title: text.view }))
    if (phase === 'failed')
      return void body.append(callout('danger', text.failed + askMessage(failure, locale)))
    if (phase === 'reading')
      return void body.append(h('p', { class: 'an-muted', text: text.reading }), skeleton(5))
    if (ctx?.place?.hidden === null) body.append(callout('warning', text.hiddenUnknown))
    body.append(fieldsView(), previewView(), outputView())
    if (focusedId) body.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`)?.focus()
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
      locale = ctx.locale
      applyLook(ctx.theme, ctx.accent)
      if (!ctx.place) phase = 'noPlace'
      else if (ctx.place.view) phase = 'view'
      else {
        target = `${ctx.place.coll}_anonymised`
        render()
        // Final review Minor 10: the shape of a random sample, not of the first documents.
        sample = (
          await client.ask<{ documents: Doc[] }>('documents.aggregate', {
            pipeline: [{ $sample: { size: SAMPLE } }],
            limit: SAMPLE,
          })
        ).documents
        plans = plansOf(shapeOf(sample, hidden()))
        phase = 'ready'
      }
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  })
  render()
}
