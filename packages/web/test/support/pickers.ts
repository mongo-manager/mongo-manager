import { flushPromises } from '@vue/test-utils'

/**
 * The kit's searchable pickers (DsCombobox) by the box that marks them: open one, read what it
 * offers, pick an entry.
 */
export async function openPicker(marker: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`[${marker}] button`)
  if (!trigger) throw new Error(`no picker [${marker}]`)
  // Already open: a click would close it.
  if (trigger.getAttribute('aria-expanded') === 'true') return
  trigger.click()
  await flushPromises()
}

/** What the open picker lists, by name (its hint left out). */
export const offered = (): string[] =>
  [...document.querySelectorAll('[role="option"]')].map(
    (o) => o.querySelector('span')?.textContent?.trim() ?? '',
  )

/** The open picker's line under its list when nothing is in it. */
export const pickerEmpty = (): string =>
  document.querySelector('[role="listbox"] li:not([role="option"])')?.textContent?.trim() ?? ''

export async function pick(marker: string, name: string): Promise<void> {
  await openPicker(marker)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.querySelector('span')?.textContent?.trim() === name,
  )
  if (!option) throw new Error(`[${marker}] offers no ${name}: ${offered().join(', ')}`)
  option.click()
  await flushPromises()
}
