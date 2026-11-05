// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { RouteLocationRaw } from 'vue-router'

/** The parts of a route (current or resolved) that name a tab. */
interface RouteLike {
  name?: unknown
  params: Record<string, unknown>
}
import type { TabInput, WorkspaceTab } from '@/stores/tabs'
import {
  BACKUP_SYSTEM_DATABASES,
  ContributionIdSchema,
  DatabaseNameSchema,
  PluginIdSchema,
} from '@mongo-manager/shared/browser'

const BUCKET = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Route names that show the workspace; each one is a tab. */
export const TAB_ROUTES = [
  'workspace',
  'connection',
  'database',
  'collection',
  'gridfs',
  'account',
  'users',
  'audit',
  'plugins',
  'compare',
  'destinations',
  'alerts',
  'aiSettings',
  'schedules',
  'liveSyncs',
  'jobs',
  'aiHistory',
  'aiHistoryRequest',
  'library',
  'pluginPage',
  'pluginDetails',
  'sqlTransfer',
  'about',
] as const

const SINGLETONS = new Set([
  'account',
  'users',
  'audit',
  'plugins',
  'destinations',
  'alerts',
  'schedules',
  'liveSyncs',
  'aiSettings',
  'jobs',
  'aiHistory',
  'library',
  'about',
])

/** Where a tab lives in the URL; the welcome tab is the workspace root. */
export function tabLocation(tab: WorkspaceTab): RouteLocationRaw {
  const { connectionId, db, coll } = tab.params
  switch (tab.kind) {
    case 'connection':
      return { name: 'connection', params: { connectionId } }
    case 'database':
      return { name: 'database', params: { connectionId, db } }
    case 'collection':
      return { name: 'collection', params: { connectionId, db, coll } }
    case 'gridfs':
      return { name: 'gridfs', params: { connectionId, db, bucket: tab.params.bucket } }
    case 'compare':
      return { name: 'compare', params: { jobId: tab.params.jobId } }
    case 'pluginDetails':
      return { name: 'pluginDetails', params: { pluginId: tab.params.pluginId } }
    case 'pluginPage':
      return {
        name: 'pluginPage',
        params: {
          plugin: tab.params.plugin,
          contribution: tab.params.contribution,
          ...(connectionId && db && coll ? { connectionId, db, coll } : {}),
        },
      }
    case 'sqlTransfer': {
      // User request 2026-10-11: the part, then where it works, in the address.
      const { part } = tab.params
      return {
        name: 'sqlTransfer',
        params: {
          ...(part ? { part } : {}),
          ...(part && connectionId ? { connectionId } : {}),
          ...(part && connectionId && db ? { db } : {}),
          // A collection only on an export's address: an import works on a database (review I9).
          ...(part === 'export' && connectionId && db && coll ? { coll } : {}),
        },
      }
    }
    case 'aiHistory':
      // User review 2026-10-09: the request shown is in the URL, to come back to (or send).
      return tab.params.requestId
        ? { name: 'aiHistoryRequest', params: { requestId: tab.params.requestId } }
        : { name: 'aiHistory' }
    default:
      return SINGLETONS.has(tab.kind) ? { name: tab.kind } : { name: 'workspace' }
  }
}

const param = (route: RouteLike, name: string): string | null => {
  const value = route.params[name]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The tab a URL asks for, or null for the workspace root. The connection tab's title is filled
 * in from the connection list by the caller.
 */
export function tabInputFromRoute(route: RouteLike): TabInput | null {
  const connectionId = param(route, 'connectionId')
  const db = param(route, 'db')
  const coll = param(route, 'coll')
  switch (route.name) {
    case 'connection':
      return connectionId ? { kind: 'connection', title: '', params: { connectionId } } : null
    case 'database':
      return connectionId && db ? { kind: 'database', title: db, params: { connectionId, db } } : null
    case 'collection':
      return connectionId && db && coll
        ? { kind: 'collection', title: `${db}.${coll}`, params: { connectionId, db, coll } }
        : null
    case 'gridfs': {
      // A bucket's name is what GridFS allows; anything else is no tab.
      const bucket = param(route, 'bucket')
      return connectionId && db && bucket && BUCKET.test(bucket)
        ? { kind: 'gridfs', title: bucket, params: { connectionId, db, bucket } }
        : null
    }
    case 'compare': {
      const jobId = param(route, 'jobId')
      return jobId ? { kind: 'compare', title: '', params: { jobId } } : null
    }
    case 'pluginDetails': {
      const pluginId = param(route, 'pluginId')
      return pluginId && PluginIdSchema.safeParse(pluginId).success
        ? { kind: 'pluginDetails', title: '', params: { pluginId } }
        : null
    }
    case 'pluginPage': {
      // Ids as plugins name them; a collection only whole.
      const plugin = param(route, 'plugin')
      const contribution = param(route, 'contribution')
      if (!plugin || !contribution) return null
      // The SQL plugin's page moved into the app (2026-10-11): an old link or tab goes to SQL ↔ MongoDB.
      if (plugin === 'sql-to-mongodb' && contribution === 'sql')
        return {
          kind: 'sqlTransfer',
          title: '',
          params:
            connectionId && db && DatabaseNameSchema.safeParse(db).success
              ? { part: 'import', connectionId, db }
              : {},
        }
      if (!PluginIdSchema.safeParse(plugin).success || !ContributionIdSchema.safeParse(contribution).success)
        return null
      // A link never puts a plugin on a system database or collection (review I2).
      const system = (db && BACKUP_SYSTEM_DATABASES.includes(db)) || coll?.startsWith('system.')
      return {
        kind: 'pluginPage',
        title: '',
        params: {
          plugin,
          contribution,
          ...(connectionId && db && coll && !system ? { connectionId, db, coll } : {}),
        },
      }
    }
    case 'sqlTransfer': {
      // Only what the page can use; anything else in the address is dropped.
      const part = param(route, 'part')
      const params: Record<string, string> = {}
      if (part === 'import' || part === 'export') {
        params.part = part
        if (connectionId && connectionId.length <= 255 && !connectionId.includes('\0')) {
          params.connectionId = connectionId
          if (db && DatabaseNameSchema.safeParse(db).success) {
            params.db = db
            if (part === 'export' && coll && coll.length <= 255 && !coll.includes('\0')) params.coll = coll
          }
        }
      }
      return { kind: 'sqlTransfer', title: '', params }
    }
    case 'aiHistoryRequest': {
      // A request id is a UUID; anything else in its place shows the list.
      const requestId = param(route, 'requestId')?.toLowerCase()
      return requestId && REQUEST_ID.test(requestId)
        ? { kind: 'aiHistory', title: '', params: { requestId } }
        : { kind: 'aiHistory', title: '' }
    }
    default:
      return typeof route.name === 'string' && SINGLETONS.has(route.name)
        ? { kind: route.name, title: '' }
        : null
  }
}

/** A path to return to after sign-in: only one inside this app, never another host or scheme. */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string' || !next.startsWith('/')) return null
  const control = [...next].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  if (next.startsWith('//') || next.startsWith('/\\') || control) return null
  return next
}
