// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DatabaseAccessView from '../src/dbaccess/DatabaseAccessView.vue'
import { i18n } from '../src/i18n'
import { useDialogStore } from '../src/stores/dialogs'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

/**
 * W3.1: the Users & roles section. Abuse cases on the page's side: a password kept after saving;
 * the connection's own account dropped without being told; a read-only connection offering changes;
 * MongoDB's refusal shown as an empty list.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const USERS = {
  users: [
    {
      user: 'root',
      db: 'admin',
      roles: [{ role: 'root', db: 'admin' }],
      mechanisms: ['SCRAM-SHA-256'],
      own: true,
      restrictions: 0,
    },
    {
      user: 'app',
      db: 'shop',
      roles: [{ role: 'readWrite', db: 'shop' }],
      mechanisms: ['SCRAM-SHA-256'],
      own: false,
      restrictions: 0,
    },
  ],
  more: false,
  refused: null,
}

function api(extra: Record<string, Handler> = {}) {
  return mockApi({
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/database-access/users': () => [200, USERS],
    'GET connections/c1/database-access/roles': () => [200, { roles: [], more: false, refused: [] }],
    ...extra,
  })
}

const mount = (readOnly = false) => mountApp(DatabaseAccessView, { props: { connectionId: 'c1', readOnly } })

describe('Users & roles (W3.1)', () => {
  it('lists users with their roles and marks the account the connection signs in with', async () => {
    api()
    mount()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('root')
    expect(text).toContain('This connection')
    expect(text).toContain('readWrite on shop')
    expect(text).toContain('root on admin')
  })

  it('says so when MongoDB refuses the listing, instead of showing nobody', async () => {
    api({
      'GET connections/c1/database-access/users': () => [
        200,
        { users: [], more: false, refused: 'not_permitted' },
      ],
    })
    mount()
    await flushPromises()
    expect(document.querySelector('[data-refused]')?.textContent).toContain('needs the viewUser privilege')
  })

  it('drops the own account only after the typed name and a warning, then says it is confirmed', async () => {
    const seen: string[] = []
    api({
      'DELETE connections/c1/database-access/users/admin/root': (_b, url) => {
        seen.push(url.search)
        return [204]
      },
    })
    mount()
    await flushPromises()
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="Actions for user root"]')!
    menu.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Drop user'))!
      .click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.requireText).toBe('root')
    expect(dialogs.current?.message).toContain('the account this connection signs in with')
    dialogs.settle(true)
    await flushPromises()
    expect(seen).toEqual(['?confirmOwn=true'])
  })

  it('makes a user with a generated password and a role, and keeps nothing of the password', async () => {
    const created: unknown[] = []
    const { calls } = api({
      'POST connections/c1/database-access/users': (body) => {
        created.push(body)
        return [
          201,
          {
            user: 'newbie',
            db: 'admin',
            roles: [{ role: 'readWrite', db: 'shop' }],
            mechanisms: ['SCRAM-SHA-256'],
            own: false,
            restrictions: 0,
          },
        ]
      },
    })
    mount()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-add]')!.click()
    await flushPromises()
    await typeInto(byLabel('Username'), 'newbie')
    button('Generate').click()
    await flushPromises()
    const password = document.querySelector<HTMLInputElement>('input[data-db-password]')!
    expect(password.value).toHaveLength(24)
    expect(password.type).toBe('text')
    const generated = password.value
    await choose(byLabel<HTMLSelectElement>('Role'), 'builtin:readWrite')
    await typeInto(byLabel('On database'), 'shop')
    button('Add role').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-user]')!.click()
    await flushPromises()
    expect(created).toEqual([
      { db: 'admin', user: 'newbie', password: generated, roles: [{ role: 'readWrite', db: 'shop' }] },
    ])
    // The sheet is gone, and with it the only copy of the password the page had.
    expect(document.querySelector('input[data-db-password]')).toBeNull()
    expect(JSON.stringify(localStorage)).not.toContain(generated)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  // W3 review (M4): a custom role with broad rights is asked about too, and the server is told.
  it('asks before granting a broad custom role, and says it was confirmed', async () => {
    const created: unknown[] = []
    api({
      'GET connections/c1/database-access/roles': () => [
        200,
        {
          roles: [
            {
              role: 'userMaker',
              db: 'admin',
              own: false,
              broad: true,
              builtin: false,
              roles: [],
              inheritedRoles: [],
              privileges: [],
              inheritedPrivileges: [],
            },
          ],
          more: false,
          refused: [],
        },
      ],
      'POST connections/c1/database-access/users': (body) => {
        created.push(body)
        return [201, { user: 'm', db: 'admin', roles: [], mechanisms: [], own: false, restrictions: 0 }]
      },
    })
    mount()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-add]')!.click()
    await flushPromises()
    await typeInto(byLabel('Username'), 'm')
    button('Generate').click()
    await choose(byLabel<HTMLSelectElement>('Role'), 'custom:admin:userMaker')
    await flushPromises()
    button('Add role').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-user]')!.click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Grant broad rights?')
    dialogs.settle(true)
    await flushPromises()
    expect(created).toEqual([expect.objectContaining({ confirmBroad: true })])
  })

  // W3 review (M2): a role the connection's account holds is dropped only when that is confirmed.
  it('drops a role the connection’s account holds only with confirmOwn', async () => {
    const seen: string[] = []
    api({
      'GET connections/c1/database-access/roles': () => [
        200,
        {
          roles: [
            {
              role: 'opsRole',
              db: 'admin',
              own: true,
              broad: false,
              builtin: false,
              roles: [],
              inheritedRoles: [],
              privileges: [],
              inheritedPrivileges: [],
            },
          ],
          more: false,
          refused: [],
        },
      ],
      'DELETE connections/c1/database-access/roles/admin/opsRole': (_b, url) => {
        seen.push(url.search)
        return [204]
      },
    })
    mount()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.includes('Custom roles'))!
      .click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Actions for role opsRole"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Drop role'))!
      .click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.message).toContain('the connection signs in with holds it')
    dialogs.settle(true)
    await flushPromises()
    expect(seen).toEqual(['?confirmOwn=true'])
  })

  // Re-review (1): the page cannot always know a role is broad (its filter lists one database's
  // roles); the server's refusal brings the confirmation, and the change is sent again confirmed.
  it('confirms broad rights the server found, and sends the change again', async () => {
    const patches: unknown[] = []
    api({
      'GET connections/c1/database-access/users': () => [
        200,
        {
          users: [
            {
              user: 'app',
              db: 'shop',
              roles: [
                { role: 'readWrite', db: 'shop' },
                { role: 'ops', db: 'admin' },
              ],
              mechanisms: ['SCRAM-SHA-256'],
              own: false,
              restrictions: 0,
            },
          ],
          more: false,
          refused: null,
        },
      ],
      'PATCH connections/c1/database-access/users/shop/app': (body) => {
        patches.push(body)
        return (body as { confirmBroad?: boolean }).confirmBroad
          ? [
              200,
              {
                user: 'app',
                db: 'shop',
                roles: [{ role: 'ops', db: 'admin' }],
                mechanisms: [],
                own: false,
                restrictions: 0,
              },
            ]
          : [409, { code: 'CONFLICT', message: 'broad', details: { reason: 'broad_role' } }]
      },
    })
    mount()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Actions for user app"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Edit roles'))!
      .click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove readWrite on shop"]')!.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-user]')!.click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Grant broad rights?')
    dialogs.settle(true)
    await flushPromises()
    expect(patches).toEqual([
      { roles: [{ role: 'ops', db: 'admin' }] },
      { roles: [{ role: 'ops', db: 'admin' }], confirmBroad: true },
    ])
    expect(document.querySelector('[data-user-editor]')).toBeNull()
  })

  it('confirms a custom role’s broad rights the server found', async () => {
    const patches: unknown[] = []
    mockApi({
      'PATCH connections/c1/database-access/roles/shop/reports': (body) => {
        patches.push(body)
        return (body as { confirmBroad?: boolean }).confirmBroad
          ? [
              200,
              {
                role: 'reports',
                db: 'shop',
                own: false,
                broad: true,
                builtin: false,
                roles: [],
                inheritedRoles: [],
                privileges: [],
                inheritedPrivileges: [],
              },
            ]
          : [409, { code: 'CONFLICT', message: 'broad', details: { reason: 'broad_role' } }]
      },
    })
    const { default: RoleEditor } = await import('../src/dbaccess/RoleEditor.vue')
    mountApp(RoleEditor, {
      props: {
        connectionId: 'c1',
        databases: ['shop'],
        customRoles: [],
        existing: {
          role: 'reports',
          db: 'shop',
          own: false,
          broad: false,
          builtin: false,
          roles: [{ role: 'helper', db: 'shop' }],
          inheritedRoles: [],
          privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find'] }],
          inheritedPrivileges: [],
        },
      },
    })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-role]')!.click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Give this role broad rights?')
    dialogs.settle(true)
    await flushPromises()
    expect(patches).toHaveLength(2)
    expect(patches[1]).toMatchObject({ confirmBroad: true })
  })

  it('asks before granting a role that rules the deployment', async () => {
    const created: unknown[] = []
    api({
      'POST connections/c1/database-access/users': (body) => {
        created.push(body)
        return [201, { user: 'boss', db: 'admin', roles: [], mechanisms: [], own: false, restrictions: 0 }]
      },
    })
    mount()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-add]')!.click()
    await flushPromises()
    await typeInto(byLabel('Username'), 'boss')
    button('Generate').click()
    await choose(byLabel<HTMLSelectElement>('Role'), 'builtin:root')
    await flushPromises()
    button('Add role').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-user]')!.click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Grant broad rights?')
    dialogs.settle(false)
    await flushPromises()
    expect(created).toEqual([])
  })

  // Review of B4 (I1): every built-in of admin reaches beyond one database — asked about as the server asks.
  it('asks before granting an admin-only built-in that reads every database', async () => {
    const created: unknown[] = []
    api({
      'POST connections/c1/database-access/users': (body) => {
        created.push(body)
        return [201, { user: 'auditor', db: 'admin', roles: [], mechanisms: [], own: false, restrictions: 0 }]
      },
    })
    mount()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-add]')!.click()
    await flushPromises()
    await typeInto(byLabel('Username'), 'auditor')
    button('Generate').click()
    await choose(byLabel<HTMLSelectElement>('Role'), 'builtin:readAnyDatabase')
    await flushPromises()
    button('Add role').click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-save-user]')!.click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Grant broad rights?')
    dialogs.settle(true)
    await flushPromises()
    expect(created).toEqual([expect.objectContaining({ confirmBroad: true })])
  })

  it('offers no changes on a read-only connection', async () => {
    api()
    mount(true)
    await flushPromises()
    expect(document.querySelector('[data-add]')).toBeNull()
    expect(document.querySelector('button[aria-label="Actions for user root"]')).toBeNull()
    expect(document.body.textContent).toContain('This connection is read-only')
  })
})
