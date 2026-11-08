// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StageCard from '../src/aggregation/StageCard.vue'
import StagePicker from '../src/aggregation/StagePicker.vue'
import { newCard } from '../src/aggregation/stages'
import { searchStages } from '../src/aggregation/stageSearch'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const describeEn = (operator: string) => i18n.global.t(`aggregation.stageHelp.${operator.slice(1)}`)

/** W2.5 (2026-10-16): the stage operator is picked from a searchable list with what each does. */
describe('stage search', () => {
  it('ranks operators that start with the words first, then those that contain them, then descriptions', () => {
    expect(searchStages('sort', describeEn).slice(0, 2)).toEqual(['$sort', '$sortByCount'])
    expect(searchStages('$look', describeEn)).toEqual(['$lookup', '$graphLookup'])
    // "join" names no operator: the description of $lookup says it.
    expect(searchStages('join', describeEn)).toContain('$lookup')
    expect(searchStages('', describeEn)).toHaveLength(searchStages('', describeEn).length)
    expect(searchStages('zzzz', describeEn)).toEqual([])
  })
})

// W2 review (minor 7): typed in a Turkish keyboard's letters or capitals, LIMIT still finds $limit.
describe('stage search in any locale', () => {
  it('folds I, İ and ı the same way, whatever the browser’s language', () => {
    for (const q of ['LIMIT', 'LİMİT', 'lımıt', 'Limit'])
      expect(searchStages(q, () => '')[0], q).toBe('$limit')
    expect(searchStages('İLK', () => 'İlk N belgeyi geçirir')).toContain('$match')
  })
})

describe('Add stage', () => {
  it('finds a stage by what it does too', async () => {
    mountApp(StagePicker)
    ;(document.querySelector('button[aria-expanded]') as HTMLButtonElement).click()
    await flushPromises()
    const search = document.querySelector('input[type="search"]') as HTMLInputElement
    search.value = 'join'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(
      [...document.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-operator')),
    ).toContain('$lookup')
  })
})

describe('the stage operator combobox', () => {
  function mounted(operator = '$match') {
    const card = newCard(operator)
    const { wrapper } = mountApp(StageCard, {
      props: {
        card,
        index: 0,
        total: 2,
        result: null,
        loading: false,
        previewMode: 'json',
        completions: [],
      },
    })
    const input = document.querySelector('input[role="combobox"]') as HTMLInputElement
    return { wrapper, input }
  }
  const type = async (input: HTMLInputElement, text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }
  const key = async (input: HTMLInputElement, k: string, extra: KeyboardEventInit = {}) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
    await flushPromises()
  }
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-operator'))

  it('shows the operator, and lists the stages with a description and an example as one types', async () => {
    const { input } = mounted()
    expect(input.getAttribute('aria-label')).toBe('Operator')
    expect(input.value).toBe('$match')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    await type(input, 'sor')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(options()).toEqual(['$sort', '$sortByCount'])
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!
    expect(active.getAttribute('data-operator')).toBe('$sort')
    // The active stage's description and example are shown beside the list.
    const detail = document.querySelector('[data-stage-detail]')!
    expect(detail.textContent).toContain('Sorts the documents')
    expect(detail.textContent).toContain('{ field: -1 }')
  })

  it('is keyboard-first: arrows move, Enter picks, Escape puts the operator back', async () => {
    const { wrapper, input } = mounted()
    await type(input, 'sor')
    await key(input, 'ArrowDown')
    expect(
      document.getElementById(input.getAttribute('aria-activedescendant')!)!.getAttribute('data-operator'),
    ).toBe('$sortByCount')
    await key(input, 'Enter')
    expect(wrapper.emitted('patch')).toEqual([[{ operator: '$sortByCount' }]])
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await type(input, 'gro')
    await key(input, 'Escape')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('$match')
    expect(wrapper.emitted('patch')).toHaveLength(1)
    // ArrowDown on a closed combobox opens the whole list.
    await key(input, 'ArrowDown')
    expect(options().length).toBeGreaterThan(20)
  })

  it('leaves Alt+arrows to move the stage, and picks with the pointer', async () => {
    const { wrapper, input } = mounted()
    await key(input, 'ArrowDown', { altKey: true })
    expect(wrapper.emitted('move')).toEqual([[1]])
    await type(input, 'limit')
    ;(document.querySelector('[role="option"][data-operator="$limit"]') as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    ;(document.querySelector('[role="option"][data-operator="$limit"]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('patch')).toEqual([[{ operator: '$limit' }]])
  })

  // W2 review (minor 6): nothing repeated on every arrow, the manual reachable from the keyboard,
  // the list kept beside its field when the page scrolls.
  it('announces nothing twice, reaches the manual with Tab, and follows the page as it scrolls', async () => {
    const { input } = mounted()
    await type(input, 'sor')
    expect(document.querySelector('[data-stage-detail]')!.hasAttribute('aria-live')).toBe(false)
    const docs = document.querySelector('[data-stage-detail] a') as HTMLAnchorElement
    expect(docs.getAttribute('tabindex')).not.toBe('-1')
    await key(input, 'Tab')
    expect(document.activeElement).toBe(docs)
    // Escape from the link closes the list and goes back to the field.
    docs.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // Scrolled, the list moves with its field.
    await type(input, 'sor')
    let top = 100
    input.getBoundingClientRect = () => ({
      top,
      bottom: top + 28,
      left: 10,
      right: 170,
      width: 160,
      height: 28,
      x: 10,
      y: top,
      toJSON: () => ({}),
    })
    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    const panel = document.querySelector('[data-stage-combobox]') as HTMLElement
    const first = panel.style.top
    top = 300
    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(panel.style.top).not.toBe(first)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    // A popup of the kit's kind: a dialog or sheet it opens from leaves a fallen focus to it.
    expect(panel.hasAttribute('data-ds-popup')).toBe(true)
  })

  // Re-review (minor 1): the list lives at the end of the page; leaving its link by Tab or Shift+Tab
  // closes it and goes back to the field, never to the end of the page or the app's last control.
  it.each([false, true])('leaves the manual link back to the field (Shift: %s)', async (shiftKey) => {
    const { input } = mounted()
    await type(input, 'sor')
    await key(input, 'Tab')
    const docs = document.activeElement as HTMLAnchorElement
    expect(docs.tagName).toBe('A')
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    docs.dispatchEvent(tab)
    await flushPromises()
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('holds a press on its text in its panel, which closes on Escape back to the field', async () => {
    const { input } = mounted()
    await type(input, 'sor')
    const panel = document.querySelector<HTMLElement>('[data-stage-combobox]')!
    expect(panel.getAttribute('tabindex')).toBe('-1')
    panel.focus()
    // A key a moment after the panel came, as a person presses one (Vue drops an event stamped in the
    // very millisecond its listener was attached).
    await new Promise((r) => setTimeout(r, 5))
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(input)
  })

  it('says when nothing matches, and keeps an operator the catalogue lacks', async () => {
    const { input } = mounted('$changeStream')
    expect(input.value).toBe('$changeStream')
    await type(input, 'qqq')
    expect(document.body.textContent).toContain('No stage matches')
  })
})
