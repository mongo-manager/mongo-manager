// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import DsSheet from '../src/ds/DsSheet.vue'
import DsStepper from '../src/ds/DsStepper.vue'
import PreflightList from '../src/backup/PreflightList.vue'
import { generatePassword, passwordStrength } from '../src/backup/password'
import { useResumableUpload } from '../src/backup/useResumableUpload'
import { useToastStore } from '../src/stores/toasts'
import { formatDuration, formatRelative } from '../src/format'
import { setCsrfToken } from '../src/api/client'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setCsrfToken(undefined)
  document.body.innerHTML = ''
})

describe('DsSheet and DsStepper (U12, U14)', () => {
  it('asks before closing a dirty sheet, and closes a clean one at once', async () => {
    const closed = vi.fn()
    const { wrapper } = mountApp(DsSheet, {
      props: { open: true, title: 'Back up shop', dirty: true, onClose: closed },
      slots: { default: () => 'body' },
    })
    await flushPromises()
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(closed).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Discard these settings?')
    button('Keep editing').click()
    await flushPromises()
    expect(document.body.textContent).not.toContain('Discard these settings?')
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    button('Discard').click()
    expect(closed).toHaveBeenCalledTimes(1)
    // The owner closes it; opened again with nothing to lose, Escape closes at once.
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true, dirty: false })
    await flushPromises()
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closed).toHaveBeenCalledTimes(2)
  })

  it('keeps the focus inside when the focused control disappears (U12)', async () => {
    const show = ref(true)
    const Host = defineComponent(
      () => () =>
        h(
          DsSheet,
          { open: true, title: 'T' },
          {
            default: () => 'x',
            footer: () => (show.value ? h('button', { type: 'button', id: 'next' }, 'Next') : null),
          },
        ),
    )
    mountApp(Host)
    await flushPromises()
    document.getElementById('next')!.focus()
    show.value = false
    await flushPromises()
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  })

  it('passes other keys to its owner', async () => {
    const keydown = vi.fn()
    mountApp(DsSheet, {
      props: { open: true, title: 'T', onKeydown: keydown },
      slots: { default: () => 'x' },
    })
    await flushPromises()
    document
      .querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(keydown).toHaveBeenCalledTimes(1)
  })

  // Phase 3d-3b UI review: below xl the columns stack in one scrolling grid of fixed height; a
  // column allowed to shrink there (min-height 0) let the summary paint over the form at 1024 px.
  it('lets its columns shrink only where each one scrolls on its own (xl)', async () => {
    mountApp(DsSheet, {
      props: { open: true, title: 'T' },
      slots: { default: () => 'x', summary: () => 's', stepper: () => 'n' },
    })
    await flushPromises()
    const body = document.querySelector<HTMLElement>('[role="dialog"] section')!.parentElement!
    for (const column of body.children)
      expect(column.classList.contains('min-h-0'), column.tagName).toBe(false)
  })

  it('marks the current step and lets done steps be chosen', async () => {
    const select = vi.fn()
    mountApp(DsStepper, {
      props: {
        label: 'Steps',
        steps: [
          { id: 'a', label: 'Scope', state: 'done' },
          { id: 'b', label: 'Format', state: 'current' },
          { id: 'c', label: 'Summary', state: 'todo' },
        ],
        onSelect: select,
      },
    })
    const items = document.querySelectorAll('button')
    expect(items[1]!.getAttribute('aria-current')).toBe('step')
    expect((items[2] as HTMLButtonElement).disabled).toBe(true)
    ;(items[0] as HTMLButtonElement).click()
    expect(select).toHaveBeenCalledWith('a')
  })
})

describe('preflight list (U2)', () => {
  it('says each check in words and offers its fix', async () => {
    const fix = vi.fn()
    mountApp(PreflightList, {
      props: {
        checks: [
          { key: 'personal', level: 'warn', params: { count: 3 }, fix: { kind: 'encrypt' } },
          {
            key: 'quota',
            level: 'block',
            params: { room: 1024, fileBytes: 4096 },
            fix: { kind: 'deleteOld' },
          },
          { key: 'size', level: 'ok', params: { bytes: 2_000_000, fileBytes: 500_000, seconds: 90 } },
          {
            key: 'timeseries',
            level: 'warn',
            params: { names: 'shop.ts' },
            fix: { kind: 'exclude', names: ['shop.ts'] },
          },
          { key: 'source', level: 'warn' },
        ],
        onFix: fix,
      },
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('3 personal fields would be readable in this file')
    expect(text).toContain('Not enough space')
    expect(text).toMatch(/about 2 min/i)
    expect(text).toContain('shop.ts')
    expect(text).toContain('This backup was taken from this deployment')
    button('Encrypt').click()
    expect(fix).toHaveBeenCalledWith('encrypt', undefined)
    button('Leave them out').click()
    expect(fix).toHaveBeenCalledWith('exclude', ['shop.ts'])
  })

  it('offers every fix of a check (final review minor 11)', () => {
    const fix = vi.fn()
    mountApp(PreflightList, {
      props: {
        checks: [
          {
            key: 'personal',
            level: 'warn',
            params: { count: 1 },
            fix: { kind: 'encrypt' },
            more: [{ kind: 'anonymous' }, { kind: 'exclude', names: ['shop.orders'] }],
          },
        ],
        onFix: fix,
      },
    })
    button('Make anonymous').click()
    button('Leave them out').click()
    expect(fix.mock.calls).toEqual([
      ['anonymous', undefined],
      ['exclude', ['shop.orders']],
    ])
  })

  it('shows placeholders while the first checks load', () => {
    mountApp(PreflightList, { props: { checks: [], loading: true } })
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    // The kit's skeletons (hidden from screen readers; the list says it is busy).
    expect(document.querySelectorAll('[aria-busy="true"] li > [aria-hidden="true"]')).toHaveLength(4)
  })
})

describe('passwords, formats and toasts', () => {
  it('generates strong passwords and rates weak ones', () => {
    const p = generatePassword()
    expect(p).toMatch(/^[1-9A-HJ-NP-Za-km-z]{4}(-[1-9A-HJ-NP-Za-km-z]{4}){5}$/)
    expect(generatePassword()).not.toBe(p)
    expect(passwordStrength(p)).toBe('strong')
    expect(passwordStrength('password1234')).toBe('weak')
    expect(passwordStrength('aaaaaaaaaaaaaaaa')).toBe('weak')
    expect(passwordStrength('Tr0ub4dor&3xyz')).toBe('fair')
    // Password strength final review M8: the account meter's patterns count here too.
    expect(passwordStrength('Password1234!Password1234!')).toBe('weak')
    expect(passwordStrength('!@#$%^&*()_+qwertyuiop')).toBe('weak')
  })

  it('formats durations and relative times', () => {
    expect(formatDuration(90, 'en')).toMatch(/2 min/)
    expect(formatDuration(30, 'en')).toMatch(/30 sec/)
    expect(formatDuration(3900, 'en')).toMatch(/1 hr 5 min/)
    expect(formatRelative(-3 * 3600_000, 'en')).toBe('3 hours ago')
    expect(formatRelative(21 * 3600_000, 'tr')).toBe('21 saat sonra')
    expect(formatRelative(-2 * 86400_000, 'en')).toBe('2 days ago')
  })

  it('runs a toast action and reports how the toast closed (U10)', async () => {
    vi.useFakeTimers()
    const toasts = useToastStore()
    const run = vi.fn()
    const closed = vi.fn()
    toasts.push({
      kind: 'info',
      message: 'Backup deleted',
      actions: [{ label: 'Undo', run }],
      onClose: closed,
      timeoutMs: 5000,
    })
    vi.advanceTimersByTime(5000)
    expect(closed).toHaveBeenCalledWith('timeout')
    const second = vi.fn()
    toasts.push({ kind: 'info', message: 'x', actions: [{ label: 'Undo', run }], onClose: second })
    toasts.runAction(toasts.toasts.at(-1)!.id, 0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('action')
    const third = vi.fn()
    toasts.dismiss(toasts.push({ kind: 'info', message: 'y', onClose: third }))
    expect(third).toHaveBeenCalledWith('dismiss')
    vi.advanceTimersByTime(10_000)
    expect(third).toHaveBeenCalledTimes(1)
  })
})

describe('resumable upload (plan ruling 2, U4)', () => {
  const MiB = 1024 * 1024

  it('sends 8 MiB parts with the CSRF token and resumes from the server after a failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setCsrfToken('tok')
    const file = new File([new Uint8Array(20 * MiB)], 'big.archive')
    let puts = 0
    let stored = 0
    const { calls } = mockApi({
      'POST backups/uploads': () => [
        201,
        { uploadId: 'u1', name: 'big.archive', size: file.size, received: 0, complete: false },
      ],
      'PUT backups/uploads/u1': (_body, url) => {
        puts++
        const offset = Number(url.searchParams.get('offset'))
        expect(offset).toBe(stored)
        // The second part is lost on the way.
        if (puts === 2) return [502, { code: 'INTERNAL', message: 'bad gateway' }]
        stored = Math.min(file.size, offset + 8 * MiB)
        return [200, { received: stored, complete: stored === file.size }]
      },
      'GET backups/uploads/u1': () => [
        200,
        { uploadId: 'u1', name: 'big.archive', size: file.size, received: stored, complete: false },
      ],
    })
    const up = useResumableUpload()
    const id = await up.start(file)
    expect(id).toBe('u1')
    expect(up.state.value).toBe('done')
    expect(up.sent.value).toBe(file.size)
    expect(calls.some((c) => c.method === 'GET' && c.path === 'backups/uploads/u1')).toBe(true)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers['x-csrf-token']).toBe('tok')
    expect(put.headers['content-type']).toBe('application/octet-stream')
  })

  it('resumes after a part that stalled or was cut, which the server kept (final review minor 7)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const file = new File([new Uint8Array(10)], 'x.archive')
    let puts = 0
    let stored = 0
    mockApi({
      'POST backups/uploads': () => [
        201,
        { uploadId: 'u3', name: 'x', size: 10, received: 0, complete: false },
      ],
      'PUT backups/uploads/u3': () => {
        puts++
        if (puts === 1) {
          stored = 4
          return [
            400,
            { code: 'VALIDATION', message: 'The upload stalled', details: { reason: 'upload_idle' } },
          ]
        }
        stored = 10
        return [200, { received: 10, complete: true }]
      },
      'GET backups/uploads/u3': () => [
        200,
        { uploadId: 'u3', name: 'x', size: 10, received: stored, complete: false },
      ],
    })
    const up = useResumableUpload()
    expect(await up.start(file)).toBe('u3')
    expect(up.state.value).toBe('done')
  })

  it('stops on a refusal it cannot resume from', async () => {
    const file = new File([new Uint8Array(10)], 'x.archive')
    mockApi({
      'POST backups/uploads': () => [
        201,
        { uploadId: 'u2', name: 'x', size: 10, received: 0, complete: false },
      ],
      'PUT backups/uploads/u2': () => [400, { code: 'VALIDATION', message: 'More bytes than declared' }],
    })
    const up = useResumableUpload()
    await expect(up.start(file)).rejects.toThrow(/declared/)
    expect(up.state.value).toBe('error')
  })
})
