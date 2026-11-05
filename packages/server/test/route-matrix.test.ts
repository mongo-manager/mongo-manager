// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testKey } from './support/updates'
import { UI_LANGUAGES } from '@mongo-manager/shared'
import {
  ConnectionSettingsSchema,
  DATA_WRITE_PERMISSIONS,
  permissionsFor,
  type Permission,
} from '@mongo-manager/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/http/app'
import { resolveConfig } from '../src/config'
import { openStore } from '../src/store/db'
import { createSecretBox } from '../src/crypto/secret-box'
import { H, makeApp } from './helpers'
import { runSqlPlugin } from './support/sql-plugin'
import { startMongo, type TestMongo } from './support/mongo'

/**
 * S12: every route the server registers, and who may call it. A route added without an entry
 * here fails the first test, so the matrix cannot fall behind the code.
 * - public: anyone, signed in or not;
 * - signedIn: any signed-in user;
 * - { global }: a user whose role has that permission;
 * - { connection }: a user whose effective role on the connection has that permission.
 */
type Access = 'public' | 'signedIn' | { global: Permission } | { connection: Permission }

const C = '/api/connections/:id'
const NS = `${C}/databases/:db/collections/:coll`
const MATRIX: Record<string, Access> = {
  'GET /healthz': 'public',
  'GET /readyz': 'public',
  'GET /api/auth/status': 'public',
  // Review of the audit fixes (important 1): local mode's browsers — answered only in local mode
  // (not found in team mode, where this matrix runs); local-launch.test.ts covers who may call them.
  'POST /api/auth/local/claim': 'public',
  'POST /api/auth/local/link': 'public',
  'POST /api/auth/local/sign-out-all': 'public',
  'POST /api/auth/setup': 'public',
  'POST /api/auth/login': 'public',
  'POST /api/auth/login/totp': 'public',
  'POST /api/auth/login/recovery': 'public',
  'POST /api/auth/login/passkey': 'public',
  'POST /api/auth/login/passkey/options': 'public',
  'POST /api/auth/logout': 'signedIn',
  'GET /api/auth/me': 'signedIn',
  // Phase 1h: each job is checked inside, against its connection and namespace (jobs-routes.test.ts).
  'GET /api/jobs': 'signedIn',
  'GET /api/jobs/:id': 'signedIn',
  'POST /api/jobs/:id/cancel': 'signedIn',
  // Phase 1h: the upgrade checks Origin and session, the first message the CSRF token (ws.test.ts).
  'GET /ws': 'signedIn',
  'GET /api/connections/:id/server/status': { connection: 'server:monitor' },
  'GET /api/connections/:id/server/operations': { connection: 'server:monitor' },
  'POST /api/connections/:id/server/operations/:opid/kill': { connection: 'server:operations' },
  'GET /api/connections/:id/server/top': { connection: 'server:monitor' },
  // Widgets wave 2 (2026-10-27).
  'GET /api/connections/:id/server/collection-latency': { connection: 'server:monitor' },
  'GET /api/connections/:id/server/facts': { connection: 'server:monitor' },
  // Plugins wave 4.
  'GET /api/connections/:id/databases/:db/storage': { connection: 'databases:read' },
  'POST /api/connections/:id/databases/:db/collections/:coll/compact-estimate': {
    connection: 'databases:admin',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/compact': { connection: 'databases:admin' },
  'POST /api/connections/:id/databases/:db/collections/:coll/shard-key-analysis': {
    connection: 'documents:read',
  },
  'GET /api/connections/:id/server/replica': { connection: 'server:monitor' },
  // Phase 3b: the profiler (changed by connection admins).
  'GET /api/connections/:id/server/profiler': { connection: 'server:monitor' },
  'PUT /api/connections/:id/server/profiler/:db': { connection: 'server:operations' },
  'GET /api/connections/:id/server/slow-queries': { connection: 'server:monitor' },
  // Phase 3b-2: metric history (switched and deleted by connection admins).
  'GET /api/connections/:id/server/history': { connection: 'server:monitor' },
  'DELETE /api/connections/:id/server/history': { connection: 'server:operations' },
  'GET /api/connections/:id/server/history/settings': { connection: 'server:monitor' },
  'PUT /api/connections/:id/server/history/settings': { connection: 'server:operations' },
  // Phase 3b-2: the sharding overview (read-only).
  'GET /api/connections/:id/server/sharding': { connection: 'server:monitor' },
  'GET /api/connections/:id/server/sharding/detail': { connection: 'server:monitor' },
  // W3.2: sharding management (connection admins).
  [`GET ${C}/server/sharding/key-hints`]: { connection: 'databases:admin' },
  [`POST ${C}/server/sharding/collections`]: { connection: 'databases:admin' },
  [`GET ${C}/server/sharding/zones`]: { connection: 'databases:admin' },
  [`POST ${C}/server/sharding/zones/shards`]: { connection: 'databases:admin' },
  [`POST ${C}/server/sharding/zones/ranges`]: { connection: 'databases:admin' },
  [`POST ${C}/server/sharding/balancer`]: { connection: 'databases:admin' },
  [`PUT ${C}/server/sharding/balancer/window`]: { connection: 'databases:admin' },
  // W3.1: MongoDB's users and roles (connection admins; MongoDB's own rights on top).
  // W7: OIDC sign-in — each person's own (anyone who may open the connection), revoked for all by
  // those who manage connections; the identity provider's redirect comes back outside the API with
  // the flow's binding cookie (oidc-routes.test.ts).
  [`GET ${C}/oidc`]: { connection: 'connections:read' },
  [`POST ${C}/oidc/start`]: { connection: 'connections:read' },
  [`DELETE ${C}/oidc`]: { connection: 'connections:read' },
  [`GET ${C}/oidc/sessions`]: { global: 'connections:manage' },
  [`DELETE ${C}/oidc/sessions`]: { global: 'connections:manage' },
  'GET /oidc/callback': 'public',
  // W7, W8: what the connection form may offer on this server.
  'GET /api/connections/capabilities': 'signedIn',
  // W8: client-side encryption — its summary, data keys and encrypted collections (connection
  // admins), and the encrypted fields of a collection (paths only).
  [`GET ${C}/encryption`]: { connection: 'connections:read' },
  [`GET ${C}/encryption/keys`]: { connection: 'databases:admin' },
  [`POST ${C}/encryption/keys`]: { connection: 'databases:admin' },
  [`POST ${C}/encryption/keys/rewrap`]: { connection: 'databases:admin' },
  [`POST ${C}/databases/:db/encrypted-collections`]: { connection: 'databases:admin' },
  [`GET ${NS}/encrypted-fields`]: { connection: 'documents:read' },
  [`GET ${C}/database-access/users`]: { connection: 'databases:admin' },
  [`GET ${C}/database-access/users/:db/:userName`]: { connection: 'databases:admin' },
  [`POST ${C}/database-access/users`]: { connection: 'databases:admin' },
  [`PATCH ${C}/database-access/users/:db/:userName`]: { connection: 'databases:admin' },
  [`POST ${C}/database-access/users/:db/:userName/grant`]: { connection: 'databases:admin' },
  [`POST ${C}/database-access/users/:db/:userName/revoke`]: { connection: 'databases:admin' },
  [`DELETE ${C}/database-access/users/:db/:userName`]: { connection: 'databases:admin' },
  [`GET ${C}/database-access/roles`]: { connection: 'databases:admin' },
  [`POST ${C}/database-access/roles`]: { connection: 'databases:admin' },
  [`PATCH ${C}/database-access/roles/:db/:roleName`]: { connection: 'databases:admin' },
  [`DELETE ${C}/database-access/roles/:db/:roleName`]: { connection: 'databases:admin' },
  // Phase 3b-2: index suggestions from the slow queries.
  'GET /api/connections/:id/server/index-advice': { connection: 'server:monitor' },
  'POST /api/connections/:id/databases/:db/collections/:coll/schema': { connection: 'documents:read' },
  // W6.4: a database's data model, read as the schema analysis is.
  'GET /api/connections/:id/databases/:db/model': { connection: 'documents:read' },
  // Phase 4b §1: GridFS files.
  'GET /api/connections/:id/databases/:db/gridfs': { connection: 'databases:read' },
  'GET /api/connections/:id/databases/:db/gridfs/:bucket/files': { connection: 'documents:read' },
  'GET /api/connections/:id/databases/:db/gridfs/:bucket/files/:fileId/download': {
    connection: 'documents:read',
  },
  'GET /api/connections/:id/databases/:db/gridfs/:bucket/files/:fileId/preview': {
    connection: 'documents:read',
  },
  'PUT /api/connections/:id/databases/:db/gridfs/:bucket/files': { connection: 'documents:write' },
  'PATCH /api/connections/:id/databases/:db/gridfs/:bucket/files/:fileId': { connection: 'documents:write' },
  'DELETE /api/connections/:id/databases/:db/gridfs/:bucket/files/:fileId': { connection: 'documents:write' },
  'POST /api/connections/:id/databases/:db/collections/:coll/aggregate/preview': {
    connection: 'aggregation:run',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/aggregate/run': {
    connection: 'aggregation:run',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/aggregate/count': {
    connection: 'aggregation:run',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/aggregate/write-preview': {
    connection: 'documents:write',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/aggregate/write': {
    connection: 'documents:write',
  },
  'POST /api/connections/:id/databases/:db/collections/:coll/explain': { connection: 'documents:read' },
  'GET /api/connections/:id/library': { connection: 'documents:read' },
  'DELETE /api/connections/:id/library/history': { connection: 'documents:read' },
  'DELETE /api/connections/:id/library/history/:entryId': { connection: 'documents:read' },
  // W1 (completion §2): a user's own pins of saved queries (library-pins.test.ts checks what).
  'PUT /api/connections/:id/library/pins': { connection: 'documents:read' },
  // The shell routes require mayUseShell: admins pass, other roles are refused (an editor also needs
  // the per-connection shell grant, which the matrix does not set). shell:execute models that gate.
  'GET /api/connections/:id/shell/history': { connection: 'shell:execute' },
  'DELETE /api/connections/:id/shell/history': { connection: 'shell:execute' },
  // Phase 3a-2: snippets, behind the same shell gate.
  'GET /api/connections/:id/snippets': { connection: 'shell:execute' },
  'POST /api/connections/:id/snippets': { connection: 'shell:execute' },
  'GET /api/connections/:id/snippets/:snippetId': { connection: 'shell:execute' },
  'PUT /api/connections/:id/snippets/:snippetId': { connection: 'shell:execute' },
  'DELETE /api/connections/:id/snippets/:snippetId': { connection: 'shell:execute' },
  // Phase 3b: the connection's personal-field rules, for its admins.
  // Phase 3c §7: the rules applied to the caller, names only (empty unless restricted).
  'GET /api/connections/:id/personal-fields/applied': { connection: 'documents:read' },
  // Phase 3d-1: uploads and previews (the caller's own bytes; MongoDB is not reached).
  [`PUT ${C}/transfer/uploads`]: { connection: 'documents:write' },
  [`POST ${C}/transfer/uploads/:uploadId/preview`]: { connection: 'documents:write' },
  [`DELETE ${C}/transfer/uploads/:uploadId`]: { connection: 'documents:write' },
  // W4.1: sample text converted by the import rules (the caller's own text, never MongoDB).
  [`POST ${C}/transfer/convert-samples`]: { connection: 'documents:write' },
  [`POST ${NS}/import`]: { connection: 'documents:write' },
  // User request 2026-10-10: a SQL dump's tables, previewed and imported into one database.
  [`POST ${C}/transfer/uploads/:uploadId/sql-preview`]: { connection: 'documents:write' },
  [`POST ${C}/databases/:db/import-sql`]: { connection: 'documents:write' },
  'GET /api/transfer/jobs/:jobId/report': 'signedIn',
  'GET /api/transfer/jobs/:jobId/rejected': 'signedIn',
  [`POST ${NS}/export`]: { connection: 'data:export' },
  // User requests 2026-10-11, 2026-10-12: the SQL page's chosen collections of one database as SQL.
  [`POST ${C}/databases/:db/export-sql`]: { connection: 'data:export' },
  // Phase 3d-2: copy, compare and sync start from the source connection.
  [`POST ${NS}/copy/plan`]: { connection: 'data:export' },
  [`POST ${NS}/copy`]: { connection: 'data:export' },
  [`POST ${C}/databases/:db/copy/plan`]: { connection: 'data:export' },
  [`POST ${C}/databases/:db/copy`]: { connection: 'data:export' },
  [`POST ${NS}/compare`]: { connection: 'data:export' },
  [`POST ${C}/databases/:db/compare`]: { connection: 'data:export' },
  'GET /api/transfer/files/:jobId': 'signedIn',
  'GET /api/transfer/presets': 'signedIn',
  'POST /api/transfer/presets': 'signedIn',
  'PUT /api/transfer/presets/:presetId': 'signedIn',
  'DELETE /api/transfer/presets/:presetId': 'signedIn',
  'POST /api/transfer/sync': 'signedIn',
  // Phase 3d-3a: backup and restore.
  [`POST ${C}/backup/plan`]: { connection: 'data:export' },
  [`POST ${C}/backup`]: { connection: 'data:export' },
  [`POST ${C}/restore/plan`]: { connection: 'documents:write' },
  [`POST ${C}/restore`]: { connection: 'documents:write' },
  [`GET ${C}/backup/tools`]: { connection: 'documents:read' },
  'GET /api/backups': 'signedIn',
  'GET /api/backups/usage': 'signedIn',
  'GET /api/backups/:backupId/download': 'signedIn',
  'DELETE /api/backups/:backupId': 'signedIn',
  'POST /api/backups/uploads': 'signedIn',
  'PUT /api/backups/uploads/:uploadId': 'signedIn',
  'GET /api/backups/uploads/:uploadId': 'signedIn',
  'DELETE /api/backups/uploads/:uploadId': 'signedIn',
  'POST /api/backups/inspect': 'signedIn',
  // Phase 3d-3b: backup destinations.
  'GET /api/backup-destinations': 'signedIn',
  'GET /api/backup-destinations/:id/backups': 'signedIn',
  'POST /api/backup-destinations/:id/backups/fetch': 'signedIn',
  // W4.5: checked inside against the destination grant (as a fetch).
  'POST /api/backup-destinations/:id/backups/thaw': 'signedIn',
  'DELETE /api/backup-destinations/:id/backups/:copyId': 'signedIn',
  'POST /api/backups/:backupId/send': 'signedIn',
  'POST /api/backup-copies/:copyId/retry': 'signedIn',
  'DELETE /api/backup-copies/:copyId': 'signedIn',
  'GET /api/backup-destinations/all': { global: 'settings:manage' },
  'POST /api/backup-destinations': { global: 'settings:manage' },
  'PATCH /api/backup-destinations/:id': { global: 'settings:manage' },
  'DELETE /api/backup-destinations/:id': { global: 'settings:manage' },
  'POST /api/backup-destinations/test': { global: 'settings:manage' },
  'POST /api/backup-destinations/:id/test': { global: 'settings:manage' },
  'PUT /api/backup-destinations/:id/grants': { global: 'settings:manage' },
  'POST /api/backup-destinations/google/device': { global: 'settings:manage' },
  'GET /api/backup-destinations/google/device/:flowId': { global: 'settings:manage' },
  // Phase 3d-3c: a user's own backup keys.
  'GET /api/backup-keys': 'signedIn',
  'POST /api/backup-keys': 'signedIn',
  'POST /api/backup-keys/:id/confirm': 'signedIn',
  'POST /api/backup-keys/:id/activate': 'signedIn',
  'POST /api/backup-keys/:id/retire': 'signedIn',
  'POST /api/backup-keys/import': 'signedIn',
  'DELETE /api/backup-keys/:id': 'signedIn',
  // Phase 3d-3c: schedules (their owners; administrators see, pause, resume, run and delete).
  'GET /api/backup-schedules': 'signedIn',
  'POST /api/backup-schedules': 'signedIn',
  'POST /api/backup-schedules/preview': 'signedIn',
  'PATCH /api/backup-schedules/:id': 'signedIn',
  'DELETE /api/backup-schedules/:id': 'signedIn',
  'POST /api/backup-schedules/:id/pause': 'signedIn',
  'POST /api/backup-schedules/:id/resume': 'signedIn',
  'GET /api/backup-schedules/:id/runs': 'signedIn',
  'POST /api/backup-schedules/:id/run': 'signedIn',
  // Phase 3e-2: live syncs — planned, created, reviewed and confirmed on their source (export, as a
  // copy); controlled by id (their owners; administrators pause, resume, verify, stop and delete).
  [`POST ${C}/live-syncs/plan`]: { connection: 'data:export' },
  [`POST ${C}/live-syncs`]: { connection: 'data:export' },
  [`POST ${C}/live-syncs/:syncId/review`]: { connection: 'data:export' },
  [`POST ${C}/live-syncs/:syncId/confirm`]: { connection: 'data:export' },
  'GET /api/live-syncs': 'signedIn',
  'GET /api/live-syncs/:syncId': 'signedIn',
  'POST /api/live-syncs/:syncId/pause': 'signedIn',
  'POST /api/live-syncs/:syncId/resume': 'signedIn',
  'POST /api/live-syncs/:syncId/stop': 'signedIn',
  'POST /api/live-syncs/:syncId/skip': 'signedIn',
  'POST /api/live-syncs/:syncId/verify': 'signedIn',
  'POST /api/live-syncs/:syncId/finish': 'signedIn',
  'POST /api/live-syncs/:syncId/apply-schema': 'signedIn',
  'DELETE /api/live-syncs/:syncId': 'signedIn',
  // W4.6: the owner's rejected-records file (owner only; read and export rights checked inside).
  'GET /api/live-syncs/:syncId/rejected': 'signedIn',
  // W4.6: the lag history (whoever may see the sync).
  'GET /api/live-syncs/:syncId/lag': 'signedIn',
  // W4.6: the last verification's samples (owner only; read rights checked inside).
  'GET /api/live-syncs/:syncId/verify/samples': 'signedIn',
  // Phase 4a-1: the AI assistant (the action also needs documents:read, checked inside).
  'GET /api/ai/status': 'signedIn',
  'GET /api/ai/providers': { global: 'settings:manage' },
  'POST /api/ai/providers': { global: 'settings:manage' },
  'POST /api/ai/models': { global: 'settings:manage' },
  'GET /api/ai/history': 'signedIn',
  'DELETE /api/ai/history': 'signedIn',
  'GET /api/ai/history/settings': 'signedIn',
  'PUT /api/ai/history/settings': { global: 'settings:manage' },
  'GET /api/ai/history/threads/:thread': 'signedIn',
  'DELETE /api/ai/history/threads/:thread': 'signedIn',
  'GET /api/ai/history/:id': 'signedIn',
  'DELETE /api/ai/history/:id': 'signedIn',
  // User review 2026-10-09: sharing with the team (the owner's own; a teammate's read is checked inside).
  'GET /api/ai/history/sharing': 'signedIn',
  'POST /api/ai/history/:id/share': 'signedIn',
  'DELETE /api/ai/history/:id/share': 'signedIn',
  'GET /api/ai/history/:id/chain': 'signedIn',
  'GET /api/ai/usage': 'signedIn',
  'GET /api/me/dashboard': 'signedIn',
  'PUT /api/me/dashboard': 'signedIn',
  'DELETE /api/me/dashboard': 'signedIn',
  'GET /api/me/shortcuts': 'signedIn',
  'PUT /api/me/shortcuts': 'signedIn',
  'DELETE /api/me/shortcuts': 'signedIn',
  // W6.2: the next steps put in order by the AI; each step's connection is checked inside (next-actions.test.ts).
  'POST /api/me/next-actions/rank': 'signedIn',
  // Phase 4b §2: the plugins that run, for every app; managing them is for administrators.
  'GET /api/plugins': 'signedIn',
  'GET /api/plugins/:pluginId/ticket': 'signedIn',
  // Phase 4b §3: no session by design — a signed, short-lived ticket in the path (plugin-frame.test.ts).
  'GET /plugin-frame/:ticket/*': 'public',
  'GET /api/plugins/manage': { global: 'settings:manage' },
  // User request 2026-10-10: a plugin's README, for its details page.
  'GET /api/plugins/:pluginId/readme': { global: 'settings:manage' },
  'POST /api/plugins/scan': { global: 'settings:manage' },
  'PUT /api/plugins': { global: 'settings:manage' },
  // User request 2026-10-11: a plugin from a public GitHub repository's release.
  'POST /api/plugins/github': { global: 'settings:manage' },
  // The updater (2026-11-03): the version for everyone; checking and installing for administrators.
  'GET /api/updates': 'signedIn',
  'POST /api/updates/check': { global: 'settings:manage' },
  'PUT /api/updates/settings': { global: 'settings:manage' },
  'POST /api/updates/install': { global: 'settings:manage' },
  'POST /api/plugins/:pluginId/approve': { global: 'settings:manage' },
  'POST /api/plugins/:pluginId/disable': { global: 'settings:manage' },
  'PUT /api/plugins/:pluginId/settings': { global: 'settings:manage' },
  'DELETE /api/plugins/:pluginId': { global: 'settings:manage' },
  'PATCH /api/ai/providers/:id': { global: 'settings:manage' },
  'DELETE /api/ai/providers/:id': { global: 'settings:manage' },
  'POST /api/ai/providers/:id/test': { global: 'settings:manage' },
  [`POST ${NS}/ai`]: { connection: 'ai:use' },
  // Phase 4a-2: chats are their owner's; listing and reading need ai:use somewhere (plan ruling 8).
  'GET /api/ai/chats': { global: 'ai:use' },
  'DELETE /api/ai/chats': 'signedIn',
  'GET /api/ai/chats/:chat': { global: 'ai:use' },
  'PATCH /api/ai/chats/:chat': { global: 'ai:use' },
  'DELETE /api/ai/chats/:chat': 'signedIn',
  'POST /api/ai/chat': { global: 'ai:use' },
  [`POST ${NS}/ai/chat`]: { connection: 'ai:use' },
  // W6.3: the agent's turns need ai:use somewhere (its tools then call each route as the person);
  // answering a change is the turn's own person's (any other finds nothing: ai-agent-security).
  'POST /api/ai/agent': { global: 'ai:use' },
  'POST /api/ai/agent/runs/:run/decide': 'signedIn',
  'GET /api/me/ai-agent': 'signedIn',
  'PUT /api/me/ai-agent': 'signedIn',
  'GET /api/ai/agent-policy': { global: 'settings:manage' },
  'PUT /api/ai/agent-policy': { global: 'settings:manage' },
  'GET /api/connections/:id/personal-fields': { connection: 'connections:manage' },
  'PUT /api/connections/:id/personal-fields': { connection: 'connections:manage' },
  // User request 2026-10-24: a team member's "hide from me" (404 to the local user).
  'PUT /api/connections/:id/personal-fields/self': { connection: 'connections:manage' },
  'GET /api/connections/:id/databases/:db/collections/:coll/favourites': { connection: 'documents:read' },
  'POST /api/connections/:id/databases/:db/collections/:coll/favourites': { connection: 'documents:read' },
  'PUT /api/connections/:id/databases/:db/collections/:coll/favourites/:favId': {
    connection: 'documents:read',
  },
  'DELETE /api/connections/:id/databases/:db/collections/:coll/favourites/:favId': {
    connection: 'documents:read',
  },
  'GET /api/connections/:id/databases/:db/collections/:coll/validation': { connection: 'databases:read' },
  'PUT /api/connections/:id/databases/:db/collections/:coll/validation': { connection: 'databases:write' },
  // W4.7: pre- and post-images (a collMod, as validation rules).
  'PUT /api/connections/:id/databases/:db/collections/:coll/pre-images': { connection: 'databases:write' },
  // W4.7: a viewer's recorded feeds (their own files; a download needs the export right).
  'GET /api/connections/:id/watch/recordings': { connection: 'documents:read' },
  'GET /api/connections/:id/backup/drill-leftovers': { connection: 'connections:manage' },
  'POST /api/connections/:id/backup/drill-leftovers/drop': { connection: 'connections:manage' },
  'GET /api/connections/:id/watch/recordings/:fileId': { connection: 'data:export' },
  'GET /api/connections/:id/watch/recordings/:fileId/events': { connection: 'data:export' },
  'DELETE /api/connections/:id/watch/recordings/:fileId': { connection: 'documents:read' },
  'POST /api/connections/:id/databases/:db/collections/:coll/validation/test': {
    connection: 'documents:read',
  },
  'GET /api/connections/:id/databases/:db/collections/:coll/pipelines': { connection: 'aggregation:run' },
  'POST /api/connections/:id/databases/:db/collections/:coll/pipelines': { connection: 'aggregation:run' },
  'PUT /api/connections/:id/databases/:db/collections/:coll/pipelines/:pipelineId': {
    connection: 'aggregation:run',
  },
  'DELETE /api/connections/:id/databases/:db/collections/:coll/pipelines/:pipelineId': {
    connection: 'aggregation:run',
  },
  'POST /api/auth/password': 'signedIn',
  'GET /api/auth/passkeys': 'signedIn',
  'POST /api/auth/passkeys': 'signedIn',
  'GET /api/auth/passkeys/support': 'signedIn',
  'POST /api/auth/passkeys/options': 'signedIn',
  'PATCH /api/auth/passkeys/:id': 'signedIn',
  'DELETE /api/auth/passkeys/:id': 'signedIn',
  'POST /api/auth/totp/enroll': 'signedIn',
  'POST /api/auth/totp/confirm': 'signedIn',
  'POST /api/auth/totp/disable': 'signedIn',
  'POST /api/auth/recovery-codes': 'signedIn',
  'POST /api/auth/step-up': 'signedIn',
  'POST /api/auth/step-up/passkey/options': 'signedIn',
  'POST /api/auth/step-up/passkey': 'signedIn',
  'GET /api/audit': { global: 'audit:read' },
  // Phase 4c: the log's export and how long it is kept.
  'GET /api/audit/export': { global: 'audit:read' },
  // Security audit 2026-10-16: whether the audit chain checks.
  'GET /api/audit/integrity': { global: 'audit:read' },
  'GET /api/audit/settings': { global: 'audit:read' },
  'PUT /api/audit/settings': { global: 'settings:manage' },
  'GET /api/users': { global: 'users:manage' },
  // Phase 4c: mandatory admin 2FA and the users' activity.
  'GET /api/users/policy': { global: 'users:manage' },
  'PUT /api/users/policy': { global: 'users:manage' },
  'GET /api/users/session-policy': { global: 'users:manage' },
  'PUT /api/users/session-policy': { global: 'users:manage' },
  'GET /api/users/bans': { global: 'users:manage' },
  'POST /api/users/bans': { global: 'users:manage' },
  'POST /api/users/bans/lift': { global: 'users:manage' },
  'GET /api/users/access': { global: 'users:manage' },
  'POST /api/users/access/preview': { global: 'users:manage' },
  'PUT /api/users/access': { global: 'users:manage' },
  'GET /api/users/activity': { global: 'users:manage' },
  'POST /api/users': { global: 'users:manage' },
  'PATCH /api/users/:id': { global: 'users:manage' },
  'DELETE /api/users/:id': { global: 'users:manage' },
  'POST /api/users/:id/password': { global: 'users:manage' },
  'POST /api/users/:id/reset-2fa': { global: 'users:manage' },
  // W3.3: alerts — rules, channels and history for administrators; the bell and its
  // acknowledgement for anyone signed in (filtered inside by who may watch the connection).
  'GET /api/alerts/rules': { global: 'settings:manage' },
  'POST /api/alerts/rules': { global: 'settings:manage' },
  'PATCH /api/alerts/rules/:ruleId': { global: 'settings:manage' },
  'DELETE /api/alerts/rules/:ruleId': { global: 'settings:manage' },
  'POST /api/alerts/rules/:ruleId/snooze': { global: 'settings:manage' },
  // Design 2026-10-25 (C7): scheduled reports, an administrator's as the rules are.
  'GET /api/alerts/reports': { global: 'settings:manage' },
  'POST /api/alerts/reports': { global: 'settings:manage' },
  'PATCH /api/alerts/reports/:reportId': { global: 'settings:manage' },
  'DELETE /api/alerts/reports/:reportId': { global: 'settings:manage' },
  'POST /api/alerts/reports/:reportId/run': { global: 'settings:manage' },
  'GET /api/alerts/channels': { global: 'settings:manage' },
  'PUT /api/alerts/channels/email': { global: 'settings:manage' },
  'PATCH /api/alerts/channels/email': { global: 'settings:manage' },
  'POST /api/alerts/channels/email/test': { global: 'settings:manage' },
  'POST /api/alerts/channels/webhooks': { global: 'settings:manage' },
  'PATCH /api/alerts/channels/webhooks/:webhookId': { global: 'settings:manage' },
  'DELETE /api/alerts/channels/webhooks/:webhookId': { global: 'settings:manage' },
  'POST /api/alerts/channels/webhooks/:webhookId/test': { global: 'settings:manage' },
  'GET /api/alerts/history': { global: 'settings:manage' },
  'GET /api/alerts/active': 'signedIn',
  'POST /api/alerts/:alertId/acknowledge': { global: 'settings:manage' },
  'POST /api/alerts/:alertId/dismiss': 'signedIn',
  'GET /api/me/alerts': 'signedIn',
  'PUT /api/me/alerts': 'signedIn',
  // W3.4: live health (the list never opens a connection; alert counts only where one may watch).
  'GET /api/connections/health': 'signedIn',
  [`GET ${C}/health`]: { connection: 'connections:read' },
  'GET /api/connections': 'signedIn',
  'POST /api/connections': { global: 'connections:manage' },
  'POST /api/connections/parse-uri': 'signedIn',
  'POST /api/connections/test': { global: 'connections:manage' },
  'POST /api/connections/export': { global: 'connections:manage' },
  'POST /api/connections/import': { global: 'connections:manage' },
  [`GET ${C}`]: { connection: 'connections:read' },
  [`PATCH ${C}`]: { global: 'connections:manage' },
  [`DELETE ${C}`]: { global: 'connections:manage' },
  [`POST ${C}/test`]: { connection: 'connections:read' },
  [`GET ${C}/grants`]: { global: 'users:manage' },
  [`PUT ${C}/grants/:userId`]: { global: 'users:manage' },
  [`GET ${C}/databases`]: { connection: 'databases:read' },
  [`POST ${C}/databases`]: { connection: 'databases:write' },
  [`DELETE ${C}/databases/:db`]: { connection: 'databases:write' },
  [`GET ${C}/databases/:db/stats`]: { connection: 'databases:read' },
  [`GET ${C}/databases/:db/collections`]: { connection: 'databases:read' },
  [`POST ${C}/databases/:db/collections`]: { connection: 'databases:write' },
  [`DELETE ${NS}`]: { connection: 'databases:write' },
  [`POST ${NS}/rename`]: { connection: 'databases:write' },
  // W2.2, W2.4: a view's pipeline edited in place; a collection's pre/post images on or off.
  [`GET ${NS}/view`]: { connection: 'databases:read' },
  [`PUT ${NS}/view`]: { connection: 'databases:write' },
  [`PATCH ${NS}/options`]: { connection: 'databases:write' },
  [`GET ${NS}/recent-queries`]: { connection: 'documents:read' },
  [`DELETE ${NS}/recent-queries`]: { connection: 'documents:read' },
  [`GET ${NS}/stats`]: { connection: 'databases:read' },
  [`POST ${NS}/find`]: { connection: 'documents:read' },
  [`POST ${NS}/count`]: { connection: 'documents:read' },
  [`POST ${NS}/documents`]: { connection: 'documents:write' },
  [`POST ${NS}/documents/get`]: { connection: 'documents:read' },
  [`POST ${NS}/documents/update`]: { connection: 'documents:write' },
  [`POST ${NS}/documents/replace`]: { connection: 'documents:write' },
  [`POST ${NS}/documents/delete`]: { connection: 'documents:write' },
  [`POST ${NS}/duplicate`]: { connection: 'databases:write' },
  [`POST ${NS}/bulk/preview`]: { connection: 'documents:read' },
  [`POST ${NS}/bulk/execute`]: { connection: 'documents:write' },
  [`GET ${NS}/indexes`]: { connection: 'databases:read' },
  [`POST ${NS}/indexes`]: { connection: 'indexes:write' },
  [`GET ${NS}/indexes/progress`]: { connection: 'databases:read' },
  [`GET ${NS}/indexes/jobs`]: { connection: 'documents:read' },
  [`PATCH ${NS}/indexes/:name`]: { connection: 'indexes:write' },
  [`DELETE ${NS}/indexes/:name`]: { connection: 'indexes:write' },
  // W2.6: Atlas Search and Vector Search indexes.
  [`GET ${NS}/search-indexes`]: { connection: 'databases:read' },
  [`POST ${NS}/search-indexes`]: { connection: 'indexes:write' },
  [`PATCH ${NS}/search-indexes/:name`]: { connection: 'indexes:write' },
  [`DELETE ${NS}/search-indexes/:name`]: { connection: 'indexes:write' },
}

/**
 * Routes that exist only in some configurations (final review 1g-3, Minor 1): the metrics scrape
 * (bearer token) and the web app with its offline docs (public by design).
 */
const CONDITIONAL: Record<string, 'public' | 'bearer'> = {
  'GET /metrics': 'bearer',
  'GET /': 'public',
  'GET /index.html': 'public',
  'GET /*': 'public',
  'GET /docs': 'public',
  'GET /docs/': 'public',
  // Languages (review, minor 2): a docs folder a language.
  ...Object.fromEntries(
    UI_LANGUAGES.filter((l) => l !== 'en').flatMap((l) => [
      [`GET /docs/${l}`, 'public' as const],
      [`GET /docs/${l}/`, 'public' as const],
    ]),
  ),
}

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

async function team(overrides = {}, connection: { readOnly?: boolean } = {}) {
  const t = await makeApp({ auth: true, ...overrides })
  // Every route reachable: the SQL pages' plugin on too (user request 2026-11-02).
  runSqlPlugin(t.app)
  // And the updater, with a release key of the test's (it reaches no network: makeApp).
  t.app.ctx.updates.deps.keys = [testKey().pub]
  const connectionId = t.app.ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: connection.readOnly ?? false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: mongo.port }] }),
    },
    null,
  ).id
  const fill = (route: string) =>
    route
      .slice(route.indexOf(' ') + 1)
      .replace(':id', connectionId)
      .replace(':db', 'matrix')
      .replace(':coll', 'items')
      .replace(':name', 'a_1')
      .replace(':opid', '12345')
      .replace(':userId', 'nobody')
      .replace(':userName', 'nobody')
      .replace(':roleName', 'nothing')
  const call = (route: string, headers: Record<string, string>, cookies: Record<string, string> = {}) => {
    const method = route.slice(0, route.indexOf(' ')) as 'GET'
    return t.app.inject({
      method,
      url: fill(route),
      headers: { ...H, ...headers },
      cookies,
      ...(method === 'GET' ? {} : { payload: {} }),
    })
  }
  /** A signed-in user; `grant` narrows (or widens) their role on the test connection. */
  const as = (role: 'viewer' | 'editor' | 'admin', grant?: 'admin' | 'editor' | 'viewer' | 'none') => {
    const user = t.app.ctx.users.create({ username: `m-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) t.app.ctx.grants.set(connectionId, user.id, grant)
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    return (route: string) => call(route, { 'x-csrf-token': session.csrfToken }, { mm_sid: sessionId })
  }
  return { t, call, as }
}

const permissionOf = (access: Access) =>
  typeof access === 'object' ? ('global' in access ? access.global : access.connection) : null

/**
 * The matrix in a safe order: signing out and deleting the connection come last, since every later
 * request needs the session and the connection.
 */
const LAST = [`DELETE ${C}`, 'POST /api/auth/logout']
const ROUTES = Object.entries(MATRIX).sort(([a], [b]) => LAST.indexOf(a) - LAST.indexOf(b))

/** Allowed means past every guard: neither refused nor answered as if the connection were gone. */
async function expectAllowed(res: { statusCode: number; body: string; json(): unknown }, label: string) {
  expect([401, 403], label).not.toContain(res.statusCode)
  // A plain GET of the WebSocket route answers 404 with no body: not a missing connection either.
  if (res.statusCode === 404 && res.body)
    expect((res.json() as { message?: string }).message, label).not.toBe('Connection not found')
}

describe('S12: every registered route has an access rule, and the server enforces it', () => {
  it('lists every route the server registers, and nothing else', async () => {
    const { t } = await team()
    expect([...t.app.routeInventory].sort()).toEqual(Object.keys(MATRIX).sort())
    await t.close()
  })

  it('lists the routes of the optional features too (metrics, web app, docs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-matrix-'))
    const store = await openStore(dir)
    const html = new TextEncoder().encode('<!doctype html><base href="/" />')
    const app = await buildApp({
      config: resolveConfig({
        cli: { dataDir: dir, logLevel: 'silent', auth: true, metricsToken: 'k'.repeat(40) },
      }),
      store,
      secretBox: createSecretBox(randomBytes(32)),
      webAssets: new Map([
        ['index.html', html],
        ['docs/index.html', html],
      ]),
    })
    try {
      expect([...app.routeInventory].sort()).toEqual(
        [...Object.keys(MATRIX), ...Object.keys(CONDITIONAL)].sort(),
      )
      for (const [route, access] of Object.entries(CONDITIONAL)) {
        if (route.endsWith('*')) continue
        const res = await app.inject({
          method: 'GET',
          url: route.slice(4),
          headers: { ...H, accept: 'text/html' },
        })
        if (access === 'public') expect(res.statusCode, route).not.toBe(401)
        else expect(res.statusCode, route).toBe(401)
      }
    } finally {
      await app.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses every non-public route without a session', async () => {
    const { t, call } = await team()
    for (const [route, access] of ROUTES) {
      if (access === 'public') continue
      const res = await call(route, {})
      expect([res.statusCode, route]).toEqual([401, route])
    }
    await t.close()
  })

  for (const role of ['viewer', 'editor', 'admin'] as const) {
    it(`gives a ${role} exactly the routes of its permissions`, async () => {
      const { t, as } = await team()
      const request = as(role)
      const allowed = permissionsFor(role)
      for (const [route, access] of ROUTES) {
        if (access === 'public') continue
        const res = await request(route)
        const label = `${role} ${route} → ${res.statusCode}`
        const permission = permissionOf(access)
        if (permission === null || allowed.has(permission)) await expectAllowed(res, label)
        else expect([res.statusCode, res.json().code], label).toEqual([403, 'FORBIDDEN'])
      }
      await t.close()
    })
  }

  it('hides the connection from a user whose grant on it is none, whatever their role (Important 2)', async () => {
    const { t, as } = await team()
    for (const role of ['viewer', 'editor'] as const) {
      const request = as(role, 'none')
      for (const [route] of ROUTES) {
        if (!route.includes(C)) continue
        const res = await request(route)
        expect([res.statusCode, res.json().code, `${role} ${route}`]).toEqual([
          404,
          'NOT_FOUND',
          `${role} ${route}`,
        ])
      }
    }
    await t.close()
  })

  it('narrows an editor granted viewer on the connection to the viewer routes (Important 2)', async () => {
    const { t, as } = await team()
    const request = as('editor', 'viewer')
    const viewer = permissionsFor('viewer')
    for (const [route, access] of ROUTES) {
      if (typeof access !== 'object' || !('connection' in access)) continue
      const res = await request(route)
      const label = `editor as viewer ${route} → ${res.statusCode}`
      if (viewer.has(access.connection)) await expectAllowed(res, label)
      else expect([res.statusCode, res.json().code], label).toEqual([403, 'FORBIDDEN'])
    }
    await t.close()
  })

  for (const [name, overrides, connection] of [
    ['read-only mode', { readOnly: true }, {}],
    ['a read-only connection', {}, { readOnly: true }],
  ] as const) {
    it(`refuses every data write in ${name}, even to an admin`, async () => {
      const { t, as } = await team(overrides, connection)
      const request = as('admin')
      for (const [route, access] of ROUTES) {
        const permission = permissionOf(access)
        if (permission === null || !DATA_WRITE_PERMISSIONS.has(permission)) continue
        const res = await request(route)
        expect([res.statusCode, res.json().code, route]).toEqual([403, 'READ_ONLY', route])
      }
      await t.close()
    })
  }
})
