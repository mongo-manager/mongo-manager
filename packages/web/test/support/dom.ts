// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { nextTick } from 'vue'

/** The form control labelled `label` (exact text), searching the whole document (dialogs teleport). */
export function byLabel<T extends HTMLElement = HTMLInputElement>(label: string, nth = 0): T {
  const labels = [...document.querySelectorAll('label')].filter((l) => l.textContent?.trim() === label)
  const match = labels[nth]
  if (!match) throw new Error(`No label "${label}" (found ${labels.length})`)
  const control = match.htmlFor
    ? document.getElementById(match.htmlFor)
    : match.querySelector('input,select,textarea')
  if (!control) throw new Error(`Label "${label}" has no control`)
  return control as T
}

export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

export async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}

export async function check(el: HTMLInputElement, value = true): Promise<void> {
  el.checked = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}

/** The button whose visible text (trimmed) is `text`. */
export function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`No button "${text}"`)
  return found
}

/** The ECharts options drawn on the page (the test stub keeps them), with the chart's accessible name. */
export function chartOptions(): Array<{ label: string; option: unknown }> {
  return [...document.querySelectorAll('[role="img"]')].flatMap((el) => {
    const stub = el.querySelector('[data-echarts]')
    return stub
      ? [
          {
            label: el.getAttribute('aria-label') ?? '',
            option: JSON.parse(stub.getAttribute('data-option')!) as unknown,
          },
        ]
      : []
  })
}

/** A value deep inside an options object: pick(option, 'series.0.data'). */
export function pick(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value)
}

/**
 * A key pressed in the millisecond a listener was attached is not handled: Vue skips a listener
 * attached at or after the moment the event was first handled (a popover's capture listener stamps
 * it). A person never presses a key that fast; a test waits a moment once a popover opens.
 */
export const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 2))

/** User review 2026-10-30: the Users page's sign-in settings are on its Security tab. */
export async function securityTab(): Promise<void> {
  for (let i = 0; i < 200 && !document.getElementById('users-view-security'); i++)
    await new Promise((r) => setTimeout(r, 5))
  document.getElementById('users-view-security')!.click()
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
}
