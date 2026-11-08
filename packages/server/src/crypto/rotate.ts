// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes } from 'node:crypto'
import { savedContext, type SavedPipelineKey } from '../aggregation/saved'
import { QueryHistoryRepo, historyContext, historyHash, type HistoryKey } from '../queries/history'
import { shellHistoryContext, shellHistoryHash, type ShellHistoryKey } from '../shell/history'
import { snippetContext, type SnippetKey } from '../queries/snippets'
import { personalFieldsContext } from '../masking/repo'
import { presetContext } from '../transfer/presets'
import { copyContext, destinationContext } from '../backup/destinations/repo'
import { keyContext } from '../backup/keys/repo'
import { placeContext } from '../livesync/repo'
import { aiKeyContext } from '../ai/providers'
import { chatMessageContext, chatTitleContext } from '../ai/chats'
import { aiRequestContext, aiRequestPreviewContext } from '../ai/requests'
import { favouriteContext } from '../queries/favourites'
import { pluginSettingsContext } from '../plugins/repo'
import { alertChannelContext } from '../alerts/repo'
import { oidcTokenContext } from '../oidc/tokens'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { backup, type DatabaseSync } from 'node:sqlite'
import { ConfigError } from '../config'
import { openStore, restrictPermissions, transaction } from '../store/db'
import { acquireInstanceLock } from '../store/lock'
import { KEY_FILE, createSecretBox, type SecretBox } from './secret-box'
import { PARTIAL } from '../store/key-file'
import { resealAppKeys } from './app-keys'

const CHECK_PLAINTEXT = 'mongo-manager'
const CHECK_CONTEXT = 'key-check'
const NEW_SUFFIX = '.new'

export interface RotationResult {
  connections: number
  totpSecrets: number
  /** Recent queries of phase 1g-1 moved into the history first (a rotation before the first start). */
  movedRecent: number
  /** Recent queries that did not open with the current key: dropped by the move. */
  droppedRecent: number
  history: number
  favourites: number
  savedPipelines: number
  shellHistory: number
  /** Shell snippets re-sealed (phase 3a-2). */
  snippets: number
  /** Personal-field rule lists re-sealed (phase 3b). */
  personalFields: number
  transferPresets: number
  /** Backup destinations' credentials (phase 3d-3b). */
  backupDestinations: number
  /** Resume states of interrupted uploads to destinations (phase 3d-3b). */
  backupCopies: number
  /** Users' backup keys (phase 3d-3c spec §3.6). */
  backupKeys: number
  liveSyncPlaces: number
  /** AI providers' keys (phase 4a-1). */
  aiProviderKeys: number
  /** AI chats' titles and messages (phase 4a-2). */
  aiChats: number
  aiChatMessages: number
  /** The AI history's kept requests (user review 2026-10-09). */
  aiRequests: number
  /** Plugins' settings (security audit 2026-10-16). */
  pluginSettings: number
  /** W3.3: the SMTP password and webhook signing secrets. */
  alertChannels: number
  /** W7: people's OIDC sign-ins (their tokens). */
  oidcTokens: number
  backupPath: string
  keyFile: string
  /** The previous key file (file mode), or null when the key is configured (MM_SECRET_KEY / config file). */
  oldKeyFile: string | null
}

export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex')
}

const getSetting = (db: DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
const setSetting = (db: DatabaseSync, key: string, value: string) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)

function parseKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== 32) throw new ConfigError(`${source} must contain a base64-encoded 32-byte key`)
  return key
}

/** Flushes a directory entry (new or renamed file) to disk; not possible on Windows, where rename is durable enough. */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directories cannot be opened for fsync on this platform.
  }
}

/** Writes a new key file that is on disk before anything depends on it; never overwrites. */
function writeKeyDurably(path: string, key: Buffer): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, `${key.toString('base64')}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDir(dirname(path))
}

/** Key files an operator may need after a mismatch: previous keys and set-aside pending keys. */
/**
 * Security audit 2026-10-16 (minor): how long a rotation's previous key and the database backup
 * sealed with it are kept. Together they open every secret as it was before the rotation, so they
 * are a recovery window, not an archive: the first start after it that opens the data with the new
 * key removes them (sweepRotationLeftovers).
 */
export const ROTATION_KEPT_MS = 7 * 86_400_000

/** secret.key.old-<ms>, secret.key.new.discarded-<ms>, mongo-manager.db.bak-rotate-<ms>. */
const LEFTOVER = /^(?:secret\.key\.old|secret\.key\.new\.discarded|mongo-manager\.db\.bak-rotate)-(\d{10,})$/

/**
 * Removes a rotation's leftovers (previous keys, discarded pending keys, backups sealed with the
 * previous key) whose rotation is older than ROTATION_KEPT_MS, by the time in their names. Call it
 * only once the current key has opened the data. Anything else is left alone.
 */
export function sweepRotationLeftovers(dataDir: string, now: number): { removed: string[]; kept: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  if (!existsSync(dataDir)) return { removed, kept }
  for (const name of readdirSync(dataDir)) {
    const m = LEFTOVER.exec(name)
    if (!m) continue
    // Independent review of the security pass (minor): not the name alone (a clock that jumped, a
    // name made up) — the file must be as old: its last change or rename (ctime) and its content.
    let fileAt: number
    try {
      const s = statSync(join(dataDir, name))
      fileAt = Math.max(s.mtimeMs, s.ctimeMs)
    } catch {
      continue
    }
    if (now - Number(m[1]) < ROTATION_KEPT_MS || now - fileAt < ROTATION_KEPT_MS) {
      kept.push(name)
      continue
    }
    rmSync(join(dataDir, name), { force: true })
    removed.push(name)
  }
  return { removed, kept }
}

function keyFilesHint(dataDir: string | undefined): string {
  if (!dataDir || !existsSync(dataDir)) return ''
  const files = readdirSync(dataDir).filter(
    (f) => f.startsWith(`${KEY_FILE}.`) && !f.endsWith(NEW_SUFFIX) && !PARTIAL.test(f),
  )
  return files.length > 0 ? ` Key files found in ${dataDir}: ${files.join(', ')}.` : ''
}

/**
 * Whether this key opens the data: the stored check value, or (in a data directory from before
 * the check existed) any existing secret. `unknown` when there is nothing to check against.
 */
export function checkKey(db: DatabaseSync, box: SecretBox): 'match' | 'mismatch' | 'unknown' {
  const opens = (sealed: string, context: string, expected?: string): boolean => {
    try {
      const plain = box.open(sealed, context)
      return expected === undefined || plain === expected
    } catch {
      return false
    }
  }
  const sealed = getSetting(db, 'key_check')
  if (sealed !== undefined) return opens(sealed, CHECK_CONTEXT, CHECK_PLAINTEXT) ? 'match' : 'mismatch'
  const connection = db.prepare('SELECT id, settings FROM connections LIMIT 1').get() as
    { id: string; settings: string } | undefined
  if (connection)
    return opens(connection.settings, `connection:${connection.id}:settings`) ? 'match' : 'mismatch'
  const user = db.prepare('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL LIMIT 1').get() as
    { id: string; totp_secret: string } | undefined
  if (user) return opens(user.totp_secret, `totp:${user.id}`) ? 'match' : 'mismatch'
  return 'unknown'
}

/** Whether the store already holds anything sealed with some key. */
function hasSealedData(db: DatabaseSync): boolean {
  return (
    getSetting(db, 'key_check') !== undefined ||
    db.prepare('SELECT 1 FROM connections LIMIT 1').get() !== undefined ||
    db.prepare('SELECT 1 FROM users WHERE totp_secret IS NOT NULL LIMIT 1').get() !== undefined
  )
}

/**
 * Called before a key would be created (no configured key, no secret.key): a data directory
 * that already holds encrypted data must get its own key back, never a new one planted next to it.
 */
export function assertKeyMayBeCreated(db: DatabaseSync, dataDir: string, configuredKey?: string): void {
  if (configuredKey || existsSync(join(dataDir, KEY_FILE))) return
  if (hasSealedData(db)) {
    throw new ConfigError(
      `The data directory ${dataDir} holds encrypted data but no key (no ${KEY_FILE}, no MM_SECRET_KEY). ` +
        `Restore the key it was created with; a new key would make the saved secrets unreadable.${keyFilesHint(dataDir)}`,
    )
  }
}

/**
 * Detects a wrong key at startup instead of at the first decrypt, and stores the check value on
 * first use. A wrong key can never become the reference: in an older data directory the check is
 * only written after an existing secret opened with this key.
 */
export function verifyKeyCheck(db: DatabaseSync, box: SecretBox, dataDir?: string): void {
  const state = checkKey(db, box)
  if (state === 'mismatch') {
    throw new ConfigError(
      'The secret key does not match this data directory. Check MM_SECRET_KEY, secretKey in the config file ' +
        `or the secret.key file; after a key rotation, use the new key.${keyFilesHint(dataDir)}`,
    )
  }
  if (getSetting(db, 'key_check') === undefined)
    setSetting(db, 'key_check', box.seal(CHECK_PLAINTEXT, CHECK_CONTEXT))
}

/**
 * Finishes or sets aside a rotation interrupted between the database commit and the key swap.
 * Must run while holding the instance lock. A pending key is never deleted: one the database did
 * not switch to is renamed to `secret.key.new.discarded-<time>`.
 */
export function finishPendingRotation(dataDir: string, db: DatabaseSync): 'none' | 'completed' | 'discarded' {
  const keyPath = join(dataDir, KEY_FILE)
  const pending = keyPath + NEW_SUFFIX
  if (!existsSync(pending)) return 'none'
  let next: Buffer | null
  try {
    next = parseKey(readFileSync(pending, 'utf8'), pending)
  } catch {
    next = null
  }
  const stamp = Date.now()
  if (next && getSetting(db, 'key_rotation') === keyFingerprint(next)) {
    if (existsSync(keyPath)) renameSync(keyPath, `${keyPath}.old-${stamp}`)
    renameSync(pending, keyPath)
    syncDir(dataDir)
    db.prepare("DELETE FROM settings WHERE key = 'key_rotation'").run()
    return 'completed'
  }
  renameSync(pending, `${pending}.discarded-${stamp}`)
  syncDir(dataDir)
  return 'discarded'
}

/** Re-encrypts every stored secret with a new key. Holds the instance lock throughout. */
export async function rotateSecretKey(opts: {
  dataDir: string
  /** The configured key (MM_SECRET_KEY or secretKey in the config file), if any. */
  envKey?: string
  newKeyFile?: string
  now?: () => number
}): Promise<RotationResult> {
  const now = opts.now ?? Date.now
  const configured = opts.envKey !== undefined && opts.envKey !== ''
  if (configured && !opts.newKeyFile) {
    throw new ConfigError(
      'The key is configured (MM_SECRET_KEY or secretKey in the config file): pass --new-key-file <path> to ' +
        'receive the new key, then put it into your configuration.',
    )
  }
  if (!configured && opts.newKeyFile) {
    throw new ConfigError(
      '--new-key-file is only used when the key is configured (MM_SECRET_KEY or secretKey in the config file); ' +
        'with secret.key the new key replaces that file.',
    )
  }
  const lock = acquireInstanceLock(opts.dataDir, 'key rotation')
  try {
    const keyPath = join(opts.dataDir, KEY_FILE)
    const store = await openStore(opts.dataDir)
    try {
      // Complete a rotation that was interrupted before reading the key it produced.
      finishPendingRotation(opts.dataDir, store.db)
      if (!configured && !existsSync(keyPath)) throw new ConfigError(`No secret key found at ${keyPath}`)
      const oldKey = configured
        ? parseKey(opts.envKey!, 'The configured secret key')
        : parseKey(readFileSync(keyPath, 'utf8'), keyPath)
      const oldBox = createSecretBox(oldKey)
      verifyKeyCheck(store.db, oldBox, opts.dataDir)
      const stamp = now()
      const backupPath = `${store.path}.bak-rotate-${stamp}`
      await backup(store.db, backupPath)
      restrictPermissions(opts.dataDir, [backupPath])

      // Recent queries become history first, with the old key, so the rotation below has one
      // table to re-seal and never meets the old one (final review 2c, C1 and Minor 3).
      const recent = new QueryHistoryRepo(store.db, oldBox, now).moveRecent()

      const newKey = randomBytes(32)
      const target = configured ? opts.newKeyFile! : keyPath + NEW_SUFFIX
      writeKeyDurably(target, newKey)
      const newBox = createSecretBox(newKey)
      // Freed pages are zeroed, so old-key ciphertext (including that of deleted rows) is not left behind.
      store.db.exec('PRAGMA secure_delete = ON')
      let counts: {
        connections: number
        totpSecrets: number
        history: number
        favourites: number
        savedPipelines: number
        shellHistory: number
        snippets: number
        personalFields: number
        transferPresets: number
        backupDestinations: number
        backupCopies: number
        backupKeys: number
        liveSyncPlaces: number
        aiProviderKeys: number
        aiChats: number
        aiChatMessages: number
        aiRequests: number
        pluginSettings: number
        alertChannels: number
        oidcTokens: number
      }
      try {
        counts = transaction(store.db, () => {
          const rows = store.db.prepare('SELECT id, settings FROM connections').all() as Array<{
            id: string
            settings: string
          }>
          const update = store.db.prepare('UPDATE connections SET settings = ? WHERE id = ?')
          for (const row of rows) {
            const context = `connection:${row.id}:settings`
            update.run(newBox.seal(oldBox.open(row.settings, context), context), row.id)
          }
          const users = store.db
            .prepare('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL')
            .all() as Array<{ id: string; totp_secret: string }>
          const updateUser = store.db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?')
          for (const user of users) {
            const context = `totp:${user.id}`
            updateUser.run(newBox.seal(oldBox.open(user.totp_secret, context), context), user.id)
          }
          // History: bodies re-sealed, and repeat hashes re-keyed with the new key (phase 2c).
          const history = store.db
            .prepare('SELECT id, user_id, connection_id, db, coll, kind, body FROM query_history')
            .all() as unknown as Array<HistoryKey & { body: string }>
          const updateHistory = store.db.prepare(
            'UPDATE query_history SET body = ?, body_hash = ? WHERE id = ?',
          )
          for (const row of history) {
            const context = historyContext(row)
            const text = oldBox.open(row.body, context)
            updateHistory.run(newBox.seal(text, context), historyHash(newBox, row, text), row.id)
          }
          const favourites = store.db
            .prepare('SELECT id, connection_id, db, coll, query FROM saved_queries')
            .all() as unknown as Array<SavedPipelineKey & { query: string }>
          const updateFavourite = store.db.prepare('UPDATE saved_queries SET query = ? WHERE id = ?')
          for (const row of favourites) {
            const context = favouriteContext(row)
            updateFavourite.run(newBox.seal(oldBox.open(row.query, context), context), row.id)
          }
          const saved = store.db
            .prepare('SELECT id, connection_id, db, coll, pipeline FROM saved_pipelines')
            .all() as unknown as Array<SavedPipelineKey & { pipeline: string }>
          const updateSaved = store.db.prepare('UPDATE saved_pipelines SET pipeline = ? WHERE id = ?')
          for (const row of saved) {
            const context = savedContext(row)
            updateSaved.run(newBox.seal(oldBox.open(row.pipeline, context), context), row.id)
          }
          // Shell history: code re-sealed, repeat hashes re-keyed (phase 3a-1).
          const shell = store.db
            .prepare('SELECT id, user_id, connection_id, code FROM shell_history')
            .all() as unknown as Array<ShellHistoryKey & { code: string }>
          const updateShell = store.db.prepare(
            'UPDATE shell_history SET code = ?, code_hash = ? WHERE id = ?',
          )
          for (const row of shell) {
            const context = shellHistoryContext(row)
            const code = oldBox.open(row.code, context)
            updateShell.run(
              newBox.seal(code, context),
              shellHistoryHash(newBox, row.user_id, row.connection_id, code),
              row.id,
            )
          }
          // Shell snippets: the { code, params } body re-sealed (phase 3a-2).
          const snippets = store.db
            .prepare('SELECT id, connection_id, body FROM snippets')
            .all() as unknown as Array<SnippetKey & { body: string }>
          const updateSnippet = store.db.prepare('UPDATE snippets SET body = ? WHERE id = ?')
          for (const row of snippets) {
            const context = snippetContext(row)
            updateSnippet.run(newBox.seal(oldBox.open(row.body, context), context), row.id)
          }
          // Personal-field rules (phase 3b).
          const personal = store.db
            .prepare('SELECT connection_id, rules FROM personal_fields')
            .all() as unknown as Array<{ connection_id: string; rules: string }>
          const updatePersonal = store.db.prepare(
            'UPDATE personal_fields SET rules = ? WHERE connection_id = ?',
          )
          for (const row of personal) {
            const context = personalFieldsContext(row.connection_id)
            updatePersonal.run(newBox.seal(oldBox.open(row.rules, context), context), row.connection_id)
          }
          // Saved transfer settings (phase 3d-1): a filter in them can hold personal data.
          const presets = store.db
            .prepare('SELECT id, owner, body FROM transfer_presets')
            .all() as unknown as Array<{ id: string; owner: string; body: string }>
          const updatePreset = store.db.prepare('UPDATE transfer_presets SET body = ? WHERE id = ?')
          for (const row of presets) {
            const context = presetContext(row.id, row.owner)
            updatePreset.run(newBox.seal(oldBox.open(row.body, context), context), row.id)
          }
          // Backup destinations' credentials and interrupted uploads' resume states (phase 3d-3b).
          const destinations = store.db
            .prepare('SELECT id, secrets FROM backup_destinations WHERE secrets IS NOT NULL')
            .all() as unknown as Array<{ id: string; secrets: string }>
          const updateDestination = store.db.prepare(
            'UPDATE backup_destinations SET secrets = ? WHERE id = ?',
          )
          for (const row of destinations) {
            const context = destinationContext(row.id)
            updateDestination.run(newBox.seal(oldBox.open(row.secrets, context), context), row.id)
          }
          const resumes = store.db
            .prepare('SELECT id, resume FROM backup_remote_copies WHERE resume IS NOT NULL')
            .all() as unknown as Array<{ id: string; resume: string }>
          const updateResume = store.db.prepare('UPDATE backup_remote_copies SET resume = ? WHERE id = ?')
          for (const row of resumes) {
            const context = copyContext(row.id)
            updateResume.run(newBox.seal(oldBox.open(row.resume, context), context), row.id)
          }
          // Users' backup keys (phase 3d-3c spec §3.6).
          const backupKeys = store.db
            .prepare('SELECT id, owner, sealed_key FROM backup_keys')
            .all() as unknown as Array<{
            id: string
            owner: string
            sealed_key: string
          }>
          const updateKey = store.db.prepare('UPDATE backup_keys SET sealed_key = ? WHERE id = ?')
          for (const row of backupKeys) {
            const context = keyContext(row.owner, row.id)
            updateKey.run(newBox.seal(oldBox.open(row.sealed_key, context), context), row.id)
          }
          // Phase 3e-2: where each live sync resumes (resume tokens carry document keys).
          const places = store.db
            .prepare('SELECT id, place FROM live_syncs WHERE place IS NOT NULL')
            .all() as unknown as Array<{ id: string; place: string }>
          const updatePlace = store.db.prepare('UPDATE live_syncs SET place = ? WHERE id = ?')
          for (const row of places) {
            const context = placeContext(row.id)
            updatePlace.run(newBox.seal(oldBox.open(row.place, context), context), row.id)
          }
          // Phase 4a-1: AI providers' keys.
          const aiKeys = store.db
            .prepare('SELECT id, api_key FROM ai_providers WHERE api_key IS NOT NULL')
            .all() as unknown as Array<{ id: string; api_key: string }>
          const updateAiKey = store.db.prepare('UPDATE ai_providers SET api_key = ? WHERE id = ?')
          for (const row of aiKeys) {
            const context = aiKeyContext(row.id)
            updateAiKey.run(newBox.seal(oldBox.open(row.api_key, context), context), row.id)
          }
          // Phase 4a-2: chats' titles and messages.
          const chatRows = store.db
            .prepare('SELECT id, user_id, title FROM ai_chats')
            .all() as unknown as Array<{
            id: string
            user_id: string | null
            title: string
          }>
          const updateChat = store.db.prepare('UPDATE ai_chats SET title = ? WHERE id = ?')
          for (const row of chatRows) {
            const context = chatTitleContext(row.id, row.user_id)
            updateChat.run(newBox.seal(oldBox.open(row.title, context), context), row.id)
          }
          const chatMessages = store.db
            .prepare(
              'SELECT m.id, m.chat_id, c.user_id, m.body FROM ai_chat_messages m JOIN ai_chats c ON c.id = m.chat_id',
            )
            .all() as unknown as Array<{ id: string; chat_id: string; user_id: string | null; body: string }>
          const updateChatMessage = store.db.prepare('UPDATE ai_chat_messages SET body = ? WHERE id = ?')
          for (const row of chatMessages) {
            const context = chatMessageContext(row.id, row.chat_id, row.user_id)
            updateChatMessage.run(newBox.seal(oldBox.open(row.body, context), context), row.id)
          }
          const requests = store.db
            .prepare(
              'SELECT id, user_id, content, preview FROM ai_requests WHERE content IS NOT NULL OR preview IS NOT NULL',
            )
            .all() as unknown as Array<{
            id: string
            user_id: string | null
            content: string | null
            preview: string | null
          }>
          const updateRequest = store.db.prepare(
            'UPDATE ai_requests SET content = ?, preview = ?, bytes = ? WHERE id = ?',
          )
          const reseal = (text: string | null, context: string) =>
            text === null ? null : newBox.seal(oldBox.open(text, context), context)
          for (const row of requests) {
            const content = reseal(row.content, aiRequestContext(row.id, row.user_id))
            const preview = reseal(row.preview, aiRequestPreviewContext(row.id, row.user_id))
            updateRequest.run(content, preview, (content?.length ?? 0) + (preview?.length ?? 0), row.id)
          }
          // Security audit 2026-10-16 (minor): plugins' settings (sealed since then).
          const plugins = store.db
            .prepare("SELECT id, settings FROM plugins WHERE settings LIKE 'v1.%'")
            .all() as unknown as Array<{ id: string; settings: string }>
          const updatePlugin = store.db.prepare('UPDATE plugins SET settings = ? WHERE id = ?')
          for (const row of plugins) {
            const context = pluginSettingsContext(row.id)
            updatePlugin.run(newBox.seal(oldBox.open(row.settings, context), context), row.id)
          }
          // W3.3: the alert channels' secrets (the SMTP password, webhook signing secrets).
          const channels = store.db
            .prepare('SELECT id, secret FROM alert_channels WHERE secret IS NOT NULL')
            .all() as unknown as Array<{ id: string; secret: string }>
          const updateChannel = store.db.prepare('UPDATE alert_channels SET secret = ? WHERE id = ?')
          for (const row of channels) {
            const context = alertChannelContext(row.id)
            updateChannel.run(newBox.seal(oldBox.open(row.secret, context), context), row.id)
          }
          // W7: people's OIDC tokens.
          const oidcTokens = store.db
            .prepare('SELECT connection_id, user_key, sealed FROM oidc_tokens')
            .all() as unknown as Array<{ connection_id: string; user_key: string; sealed: string }>
          const updateOidc = store.db.prepare(
            'UPDATE oidc_tokens SET sealed = ? WHERE connection_id = ? AND user_key = ?',
          )
          for (const row of oidcTokens) {
            const context = oidcTokenContext(row.connection_id, row.user_key)
            updateOidc.run(
              newBox.seal(oldBox.open(row.sealed, context), context),
              row.connection_id,
              row.user_key,
            )
          }
          // Security audit 2026-10-16: the keys of the recovery codes and the audit chain.
          resealAppKeys(store.db, oldBox, newBox)
          setSetting(store.db, 'key_check', newBox.seal(CHECK_PLAINTEXT, CHECK_CONTEXT))
          if (!configured) setSetting(store.db, 'key_rotation', keyFingerprint(newKey))
          return {
            connections: rows.length,
            totpSecrets: users.length,
            history: history.length,
            favourites: favourites.length,
            savedPipelines: saved.length,
            shellHistory: shell.length,
            snippets: snippets.length,
            personalFields: personal.length,
            transferPresets: presets.length,
            backupDestinations: destinations.length,
            backupCopies: resumes.length,
            backupKeys: backupKeys.length,
            liveSyncPlaces: places.length,
            aiProviderKeys: aiKeys.length,
            aiChats: chatRows.length,
            aiChatMessages: chatMessages.length,
            aiRequests: requests.length,
            pluginSettings: plugins.length,
            alertChannels: channels.length,
            oidcTokens: oidcTokens.length,
          }
        })
      } catch (e) {
        // Rolled back: the database never used the new key, so its file can go.
        unlinkSync(target)
        throw e
      }

      let oldKeyFile: string | null = null
      try {
        if (!configured) {
          oldKeyFile = `${keyPath}.old-${stamp}`
          renameSync(keyPath, oldKeyFile)
          renameSync(target, keyPath)
          syncDir(opts.dataDir)
          store.db.prepare("DELETE FROM settings WHERE key = 'key_rotation'").run()
        }
        // Rewrite the files so old pages are gone from the database and its log.
        store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        store.db.exec('VACUUM')
        store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (e) {
        throw new ConfigError(
          `The key rotation was committed, but finishing it failed: ${(e as Error).message}. ` +
            `The next start completes it; do not delete ${target}.`,
        )
      }
      return {
        ...counts,
        movedRecent: recent.moved,
        droppedRecent: recent.dropped,
        backupPath,
        keyFile: configured ? target : keyPath,
        oldKeyFile,
      }
    } finally {
      store.close()
    }
  } finally {
    lock.release()
  }
}
