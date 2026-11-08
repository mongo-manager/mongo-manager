// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  createRouter,
  createWebHistory,
  type Router,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'
import { defineComponent } from 'vue'
import { useSessionStore } from '@/stores/session'
import { ApiError, onTwoFactorRequired } from '@/api/client'

const Empty = defineComponent({ name: 'TabRoute', render: () => null })

export const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('@/views/SetupView.vue'), meta: { public: true } },
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  // Phase 4c §4: an administrator who must set 2FA up sees this alone, never the workspace.
  {
    path: '/two-factor',
    name: 'twoFactorRequired',
    component: () => import('@/views/TwoFactorRequiredView.vue'),
  },
  {
    path: '/unavailable',
    name: 'unavailable',
    component: () => import('@/views/UnavailableView.vue'),
    meta: { public: true },
  },
  // Security audit 2026-10-16: local mode in a browser that did not come from a launch link.
  {
    path: '/open-link',
    name: 'openLink',
    component: () => import('@/views/OpenLinkView.vue'),
    meta: { public: true },
  },
  {
    // One workspace for every tab route: switching tabs never remounts it. The child routes only
    // name the active tab (useTabRouteSync); they render nothing themselves.
    path: '/',
    component: () => import('@/views/WorkspaceView.vue'),
    children: [
      { path: '', name: 'workspace', component: Empty },
      { path: 'c/:connectionId', name: 'connection', component: Empty },
      { path: 'c/:connectionId/db/:db', name: 'database', component: Empty },
      { path: 'c/:connectionId/db/:db/coll/:coll', name: 'collection', component: Empty },
      // Phase 4b §1: a GridFS bucket's files.
      { path: 'c/:connectionId/db/:db/gridfs/:bucket', name: 'gridfs', component: Empty },
      { path: 'account', name: 'account', component: Empty },
      { path: 'users', name: 'users', component: Empty },
      { path: 'audit', name: 'audit', component: Empty },
      // Phase 4b §2: plugins (administrators).
      { path: 'plugins', name: 'plugins', component: Empty },
      // User request 2026-10-10: a plugin's own page of details.
      { path: 'plugins/:pluginId', name: 'pluginDetails', component: Empty },
      { path: 'destinations', name: 'destinations', component: Empty },
      // W3.3: alerts (everyone opts in for themselves; administrators set rules and channels).
      { path: 'alerts', name: 'alerts', component: Empty },
      { path: 'ai-assistant', name: 'aiSettings', component: Empty },
      { path: 'schedules', name: 'schedules', component: Empty },
      { path: 'library', name: 'library', component: Empty },
      // User request 2026-10-11: SQL ↔ MongoDB, on a connection's database.
      { path: 'sql/:part?/:connectionId?/:db?/:coll?', name: 'sqlTransfer', component: Empty },
      // User request 2026-10-10: a plugin's page, on a collection or none.
      {
        path: 'plugin/:plugin/:contribution/:connectionId?/:db?/:coll?',
        name: 'pluginPage',
        component: Empty,
      },
      { path: 'live-syncs', name: 'liveSyncs', component: Empty },
      { path: 'jobs', name: 'jobs', component: Empty },
      { path: 'ai-history', name: 'aiHistory', component: Empty },
      { path: 'ai-history/:requestId', name: 'aiHistoryRequest', component: Empty },
      { path: 'compare/:jobId', name: 'compare', component: Empty },
      // User request 2026-10-31: the About page (everyone).
      { path: 'about', name: 'about', component: Empty },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/** Path of <base href>, so client routes live under the server's basePath. */
export function routerBase(): string {
  return new URL(document.baseURI).pathname
}

export function createAppRouter(history: RouterHistory = createWebHistory(routerBase())): Router {
  const router = createRouter({ history, routes })
  // Phase 4c §4: the server asks for 2FA set-up first (the policy was turned on while signed in):
  // the session is read again, and the set-up page is all that is shown.
  onTwoFactorRequired(() => {
    useSessionStore().ready = false
    void router.push({ name: 'twoFactorRequired' })
  })
  router.beforeEach(async (to) => {
    const session = useSessionStore()
    if (!session.ready) {
      try {
        await session.refresh()
        session.blockedAddress = null
      } catch (e) {
        // Panel access (2026-10-30): an address the panel does not answer is told so, with the address.
        const d =
          e instanceof ApiError
            ? (e.details as { reason?: unknown; address?: unknown } | undefined)
            : undefined
        session.blockedAddress = d?.reason === 'ip_not_allowed' ? String(d.address ?? '') : null
        // Server down, offline or refusing: show a retry screen rather than a blank page.
        return to.name === 'unavailable' ? true : { name: 'unavailable', query: { next: to.fullPath } }
      }
    }
    if (to.name === 'unavailable') return { name: 'workspace' }
    const status = session.status!
    // Security audit 2026-10-16: nothing but how to open it, in local mode without its cookie.
    if (status.launchRequired)
      return to.name === 'openLink'
        ? true
        : { name: 'openLink', query: { ...(to.query.link ? { link: to.query.link } : {}) } }
    if (status.setupRequired) return to.name === 'setup' ? true : { name: 'setup' }
    if (to.name === 'setup') return { name: 'workspace' }
    const isPublic = to.meta.public === true
    // The link asked for survives sign-in (checked by safeNext when it is followed).
    if (!status.authenticated && !isPublic)
      return to.fullPath === '/' ? { name: 'login' } : { name: 'login', query: { next: to.fullPath } }
    if (status.authenticated && isPublic) return { name: 'workspace' }
    const pending = !!session.me?.twoFactorRequired
    if (pending) return to.name === 'twoFactorRequired' ? true : { name: 'twoFactorRequired' }
    if (to.name === 'twoFactorRequired') return { name: 'workspace' }
    return true
  })
  return router
}
