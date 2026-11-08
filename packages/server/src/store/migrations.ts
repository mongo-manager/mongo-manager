// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Migration } from './db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'users-sessions-settings-audit',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        totp_last_step INTEGER,
        password_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id TEXT,
        username TEXT,
        ip TEXT,
        action TEXT NOT NULL,
        connection_id TEXT,
        namespace TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
        details TEXT
      );
      CREATE INDEX audit_log_at ON audit_log(at);
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TABLE passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX passkeys_user ON passkeys(user_id);
      CREATE TABLE recovery_codes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (user_id, code_hash)
      );
    `,
  },
  {
    version: 2,
    name: 'connections-and-grants',
    sql: `
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grp TEXT,
        color TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        read_only INTEGER NOT NULL DEFAULT 0,
        settings TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE connection_grants (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer', 'none')),
        PRIMARY KEY (connection_id, user_id)
      );
    `,
  },
  {
    version: 3,
    name: 'recent-queries',
    sql: `
      CREATE TABLE recent_queries (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        coll TEXT NOT NULL,
        query TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX recent_queries_by_collection ON recent_queries (connection_id, db, coll, user_id, used_at);
    `,
  },
  {
    version: 4,
    name: 'audit-by-connection',
    // The audit view filters by connection, newest first; without this every filter scans the whole log.
    sql: `
      CREATE INDEX audit_log_connection ON audit_log (connection_id, id);
    `,
  },
  {
    version: 5,
    name: 'jobs',
    // Phase 1h spec §3: background jobs outlive the request that started them and a restart.
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        coll TEXT NOT NULL,
        target TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'cancelled', 'interrupted', 'unknown')),
        progress_done INTEGER,
        progress_total INTEGER,
        estimate INTEGER,
        error TEXT,
        staging TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX jobs_state ON jobs (state);
      CREATE INDEX jobs_by_collection ON jobs (connection_id, db, coll, started_at);
    `,
  },
  {
    version: 6,
    name: 'saved-pipelines',
    // Phase 2a spec §3.2: the pipeline is sealed (AAD: id, connection, namespace); the name is not.
    sql: `
      CREATE TABLE saved_pipelines (
        id TEXT PRIMARY KEY,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        coll TEXT NOT NULL,
        name TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX saved_pipelines_by_collection ON saved_pipelines (connection_id, db, coll, owner_id);
      -- A deleted user's private pipelines go with them; shared ones stay, without an owner.
      CREATE TRIGGER saved_pipelines_owner_deleted BEFORE DELETE ON users BEGIN
        DELETE FROM saved_pipelines WHERE owner_id = OLD.id AND shared = 0;
      END;
    `,
  },
  {
    version: 7,
    name: 'history-favourites',
    // Phase 2c spec §2.1. recent_queries stays until the keyed startup step moves its rows into
    // query_history (a migration has no key to re-seal them with).
    sql: `
      CREATE TABLE query_history (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        coll TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('find', 'aggregate')),
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX query_history_by_collection ON query_history (user_id, connection_id, db, coll, used_at);
      CREATE INDEX query_history_by_hash ON query_history (user_id, body_hash);
      CREATE TABLE saved_queries (
        id TEXT PRIMARY KEY,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        coll TEXT NOT NULL,
        name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        query TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX saved_queries_by_collection ON saved_queries (connection_id, db, coll, owner_id);
      CREATE TRIGGER saved_queries_owner_deleted BEFORE DELETE ON users BEGIN
        DELETE FROM saved_queries WHERE owner_id = OLD.id AND shared = 0;
      END;
      ALTER TABLE saved_pipelines ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 8,
    name: 'shell',
    // Phase 3a-1 spec §9: an editor may be granted the advanced shell on a connection; admins have
    // it implicitly. shell_history is per user, sealed like query_history.
    sql: `
      ALTER TABLE connection_grants ADD COLUMN shell INTEGER NOT NULL DEFAULT 0 CHECK (shell IN (0, 1));
      CREATE TABLE shell_history (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX shell_history_by_connection ON shell_history (user_id, connection_id, used_at);
      CREATE INDEX shell_history_by_hash ON shell_history (user_id, code_hash);
    `,
  },
  {
    version: 9,
    name: 'snippets',
    // Phase 3a-2 spec §3.5: shell snippets per connection, the { code, params } body sealed like a
    // favourite's query. A deleted user's private snippets go; their shared ones stay, ownerless.
    sql: `
      CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX snippets_by_connection ON snippets (connection_id, owner_id);
      CREATE TRIGGER snippets_owner_deleted BEFORE DELETE ON users BEGIN
        DELETE FROM snippets WHERE owner_id = OLD.id AND shared = 0;
      END;
    `,
  },
  {
    version: 10,
    name: 'personal-fields-profiler',
    // Phase 3b spec §2 and §3.1: a connection's personal-field rules (sealed), the per-grant
    // "cannot see personal data" flag, and the pending profiler reverts.
    sql: `
      CREATE TABLE personal_fields (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        rules TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE connection_grants ADD COLUMN masked INTEGER NOT NULL DEFAULT 0 CHECK (masked IN (0, 1));
      CREATE TABLE profiler_reverts (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        previous TEXT NOT NULL,
        deadline INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        member TEXT,
        PRIMARY KEY (connection_id, db)
      );
    `,
  },
  {
    version: 11,
    name: 'metric-history',
    // Phase 3b spec §6: which connections record metric history, and the samples (numbers only).
    // A rate is NULL on a baseline sample, so averages skip it.
    sql: `
      CREATE TABLE metric_history (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        last_error TEXT,
        last_error_at INTEGER
      );
      CREATE TABLE metric_samples (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        restarted INTEGER NOT NULL DEFAULT 0,
        ops_insert REAL, ops_query REAL, ops_update REAL, ops_delete REAL, ops_getmore REAL, ops_command REAL,
        net_in REAL, net_out REAL,
        conn_current REAL NOT NULL, conn_available REAL NOT NULL,
        mem_resident REAL NOT NULL, mem_virtual REAL NOT NULL,
        cache_used REAL, cache_dirty REAL, cache_max REAL,
        q_readers REAL NOT NULL, q_writers REAL NOT NULL,
        PRIMARY KEY (connection_id, ts)
      );
    `,
  },
  {
    version: 12,
    name: 'transfer',
    // Phase 3d-1: uploaded and exported files, job reports, saved transfer settings (sealed), and
    // the per-connection export grant. Owners are user ids, or 'local' in local mode (no FK).
    sql: `
      CREATE TABLE transfer_files (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('upload', 'export', 'rejected')),
        name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        job_id TEXT,
        connection_id TEXT NOT NULL,
        namespace TEXT,
        format TEXT,
        gzip INTEGER NOT NULL DEFAULT 0 CHECK (gzip IN (0, 1)),
        masked INTEGER NOT NULL DEFAULT 0 CHECK (masked IN (0, 1)),
        rules_version INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX transfer_files_by_owner ON transfer_files (owner, kind);
      CREATE INDEX transfer_files_by_job ON transfer_files (job_id);
      CREATE INDEX transfer_files_by_expiry ON transfer_files (expires_at);
      CREATE TABLE transfer_reports (
        job_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        report TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX transfer_reports_by_owner ON transfer_reports (owner);
      CREATE TABLE transfer_presets (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('import', 'export')),
        name TEXT NOT NULL,
        namespace TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner, kind, name)
      );
      ALTER TABLE connection_grants ADD COLUMN export INTEGER NOT NULL DEFAULT 0 CHECK (export IN (0, 1));
    `,
  },
  {
    version: 13,
    name: 'copy-sync',
    // Phase 3d-2: a job may work on a second connection, and its staging collection may live there.
    // Saved transfer settings gain the kind "copy" (the CHECK needs a table rebuild).
    sql: `
      ALTER TABLE jobs ADD COLUMN target_connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
      ALTER TABLE jobs ADD COLUMN staging_connection_id TEXT;
      ALTER TABLE jobs ADD COLUMN staging_db TEXT;
      CREATE INDEX jobs_by_target ON jobs (target_connection_id);
      CREATE INDEX jobs_by_staging ON jobs (staging_connection_id);
      CREATE TABLE transfer_presets_v13 (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('import', 'export', 'copy')),
        name TEXT NOT NULL,
        namespace TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner, kind, name)
      );
      INSERT INTO transfer_presets_v13 (id, owner, kind, name, namespace, body, created_at, updated_at)
        SELECT id, owner, kind, name, namespace, body, created_at, updated_at FROM transfer_presets;
      DROP TABLE transfer_presets;
      ALTER TABLE transfer_presets_v13 RENAME TO transfer_presets;
    `,
  },
  {
    version: 14,
    name: 'backup',
    // Phase 3d-3a: kept backups and restore uploads, apart from the transfer files (plan ruling 1).
    sql: `
      CREATE TABLE backups (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('backup', 'upload')),
        name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        declared_size INTEGER,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        job_id TEXT,
        connection_id TEXT,
        meta TEXT,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX backups_by_owner ON backups (owner, kind);
      CREATE INDEX backups_by_expiry ON backups (expires_at);
    `,
  },
  {
    version: 15,
    name: 'backup-destinations',
    // Phase 3d-3b: destinations (sealed secrets), grants, and the copies sent to them; fetched uploads
    // wait for their digest before they can be restored (plan ruling 3).
    sql: `
      CREATE TABLE backup_destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        type TEXT NOT NULL CHECK (type IN ('folder', 's3', 'gdrive', 'webdav')),
        config TEXT NOT NULL,
        secrets TEXT,
        policy TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE backup_destination_grants (
        destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('send', 'browse')),
        PRIMARY KEY (destination_id, user_id)
      );
      CREATE TABLE backup_remote_copies (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
        backup_id TEXT,
        remote_key TEXT NOT NULL,
        remote_ref TEXT,
        owner TEXT NOT NULL,
        connection_id TEXT,
        meta TEXT,
        format TEXT NOT NULL CHECK (format IN ('archive', 'gzip', 'mmbak')),
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        md5 TEXT,
        state TEXT NOT NULL CHECK (state IN ('sending', 'complete', 'failed')),
        sent INTEGER NOT NULL DEFAULT 0,
        resume TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE (destination_id, remote_key)
      );
      CREATE INDEX copies_by_backup ON backup_remote_copies (backup_id);
      CREATE INDEX copies_by_owner ON backup_remote_copies (owner, destination_id);
      ALTER TABLE backups ADD COLUMN awaiting_verify INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_verify IN (0, 1));
    `,
  },
  {
    version: 16,
    name: 'backup-schedules',
    // Phase 3d-3c: per-user backup keys (sealed), schedules and their runs; which schedule made a backup
    // and a copy (retention finds its candidates through these columns). Owners carry no foreign key:
    // local mode's owner "local" has no user row (plan ruling 10).
    sql: `
      CREATE TABLE backup_keys (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'imported', 'pending')),
        sealed_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        retired_at INTEGER,
        UNIQUE (owner, fingerprint)
      );
      CREATE UNIQUE INDEX backup_keys_one_active ON backup_keys (owner) WHERE state = 'active';
      CREATE TABLE backup_schedules (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        request TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('archive', 'gzip', 'mmbak')),
        key_id TEXT REFERENCES backup_keys(id),
        cadence TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        destinations TEXT NOT NULL,
        keep_on_server INTEGER NOT NULL DEFAULT 0 CHECK (keep_on_server IN (0, 1)),
        retention TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
        pause_reason TEXT,
        paused_by TEXT,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX schedules_due ON backup_schedules (state, next_run_at);
      CREATE INDEX schedules_by_owner ON backup_schedules (owner);
      CREATE TABLE backup_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES backup_schedules(id) ON DELETE CASCADE,
        due_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'catchup', 'manual')),
        started_at INTEGER,
        finished_at INTEGER,
        outcome TEXT CHECK (outcome IN ('succeeded', 'partial', 'failed', 'skipped', 'missed')),
        reason TEXT,
        backup_id TEXT,
        dump_job_id TEXT,
        send_job_id TEXT,
        removed TEXT,
        UNIQUE (schedule_id, due_at)
      );
      CREATE INDEX runs_by_schedule ON backup_schedule_runs (schedule_id, due_at);
      ALTER TABLE backups ADD COLUMN schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL;
      ALTER TABLE backup_remote_copies ADD COLUMN schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL;
      CREATE INDEX backups_by_schedule ON backups (schedule_id);
      CREATE INDEX copies_by_schedule ON backup_remote_copies (schedule_id, destination_id);
    `,
  },
  {
    version: 17,
    name: 'live-syncs',
    // Phase 3e-2: live syncs and their activity log. Connections carry no foreign key: a deleted
    // connection stops its syncs (plan ruling 6), it does not delete them. The place (resume token)
    // is sealed; its cluster time is plain (it orders, it reveals nothing).
    sql: `
      CREATE TABLE live_syncs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        source_connection_id TEXT NOT NULL,
        source_db TEXT NOT NULL,
        source_coll TEXT,
        source_collections TEXT,
        target_connection_id TEXT NOT NULL,
        target_db TEXT NOT NULL,
        target_coll TEXT,
        options TEXT NOT NULL,
        stamps TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('copying', 'catching_up', 'live', 'paused', 'attention',
          'retrying', 'cutting_over', 'completed', 'failed', 'stopped')),
        reason TEXT,
        detail TEXT,
        paused_by TEXT,
        start_at TEXT,
        place TEXT,
        place_time TEXT,
        copy_job_id TEXT,
        copied_at INTEGER,
        counters TEXT NOT NULL,
        skip TEXT,
        verify TEXT,
        finish TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX live_syncs_by_owner ON live_syncs (owner);
      CREATE INDEX live_syncs_by_state ON live_syncs (state);
      CREATE TABLE live_sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL REFERENCES live_syncs(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX live_sync_events_by_sync ON live_sync_events (sync_id, id);
    `,
  },
  {
    version: 18,
    name: 'ai-assistant',
    // Phase 4a-1: AI providers (the key sealed, context ai-provider:<id>) and each connection's
    // AI policy (a column of its own: not part of the sealed settings, plan ruling 10).
    sql: `
      CREATE TABLE ai_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        max_tokens INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL,
        last_local INTEGER,
        last_tested_at INTEGER,
        last_test TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE connections ADD COLUMN ai_policy TEXT NOT NULL DEFAULT 'any'
        CHECK (ai_policy IN ('off', 'local', 'any'));
    `,
  },
  {
    version: 19,
    name: 'ai-chats',
    // Phase 4a-2: the gemini kind (SQLite cannot change a CHECK, so the table is rebuilt, rows kept),
    // and chats — titles and messages sealed per row, the turn record in clear on the user's row.
    sql: `
      CREATE TABLE ai_providers_next (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama', 'gemini')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        max_tokens INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL,
        last_local INTEGER,
        last_tested_at INTEGER,
        last_test TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO ai_providers_next SELECT id, name, kind, base_url, model, api_key, max_tokens, samples,
        enabled, is_default, last_local, last_tested_at, last_test, created_by, created_at, updated_at
        FROM ai_providers;
      DROP TABLE ai_providers;
      ALTER TABLE ai_providers_next RENAME TO ai_providers;
      CREATE TABLE ai_chats (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX ai_chats_by_owner ON ai_chats (user_id, updated_at);
      CREATE INDEX ai_chats_by_age ON ai_chats (updated_at);
      CREATE TABLE ai_chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        body TEXT NOT NULL,
        meta TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (chat_id, seq)
      );
    `,
  },
  {
    version: 20,
    name: 'ai-history',
    // User review 2026-10-09: every AI request kept for its owner (what was asked and answered,
    // sealed per row), the providers' prices, and settings an administrator changes in the app.
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ai_prices (
        provider_id TEXT PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
        input REAL NOT NULL,
        output REAL NOT NULL,
        currency TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ai_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        chat_id TEXT,
        connection_id TEXT,
        namespace TEXT,
        provider_id TEXT,
        provider_name TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        outcome TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        ms INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        currency TEXT,
        content TEXT
      );
      CREATE INDEX ai_requests_by_owner ON ai_requests (user_id, at);
      CREATE INDEX ai_requests_by_age ON ai_requests (at);
    `,
  },
  {
    version: 21,
    name: 'ai-history-preview',
    // AI history review I3, M7: a page reads a short sealed preview, never the full words; each row
    // counts its sealed size, so the per-user cap is a sum, not a read of every row.
    sql: `
      ALTER TABLE ai_requests ADD COLUMN preview TEXT;
      ALTER TABLE ai_requests ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
      UPDATE ai_requests SET bytes = COALESCE(LENGTH(content), 0);
    `,
  },
  {
    version: 22,
    name: 'ai-history-backfill-costs',
    // User review 2026-10-09 ("fiyat girdim ama hala fiyat gir yazıyor"): requests made before their
    // provider had a price are priced once with the price it has now — only those asked of the model
    // and kind it has now (the price is for them); a cost already counted stays.
    sql: `
      UPDATE ai_requests
         SET cost = ROUND((input * (SELECT p.input FROM ai_prices p WHERE p.provider_id = ai_requests.provider_id)
                         + output * (SELECT p.output FROM ai_prices p WHERE p.provider_id = ai_requests.provider_id))
                         / 1000000.0, 6),
             currency = (SELECT p.currency FROM ai_prices p WHERE p.provider_id = ai_requests.provider_id)
       WHERE cost IS NULL
         AND EXISTS (SELECT 1 FROM ai_prices p WHERE p.provider_id = ai_requests.provider_id)
         AND EXISTS (SELECT 1 FROM ai_providers v WHERE v.id = ai_requests.provider_id
                       AND v.kind = ai_requests.provider_kind AND v.model = ai_requests.model);
    `,
  },
  {
    version: 23,
    name: 'ai-history-chains',
    // User review 2026-10-09: a pipeline's first request and the changes asked of it after, together.
    sql: `
      ALTER TABLE ai_requests ADD COLUMN thread_id TEXT;
      ALTER TABLE ai_requests ADD COLUMN step INTEGER;
      CREATE INDEX ai_requests_by_thread ON ai_requests (user_id, thread_id, step);
    `,
  },
  {
    version: 24,
    name: 'user-preferences',
    // User review 2026-10-09: what a user arranges for themselves (the Overview dashboard), per user.
    // The owner is a user id or 'local' (local mode), so no foreign key: the users route removes rows.
    sql: `
      CREATE TABLE user_preferences (
        owner TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, key)
      );
    `,
  },
  {
    version: 25,
    name: 'ai-history-shares',
    // User review 2026-10-09 ("isterse AI geçmişini paylaşabilsin"): an entry its owner shares with
    // the team — a request alone (its id) or a chain (its chain id), so a chain's later steps are too.
    sql: `
      CREATE TABLE ai_request_shares (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (user_id, entry)
      );
    `,
  },
  {
    version: 26,
    name: 'ai-history-sources',
    // Share review: a migration of its own, so a database that ran version 25 gets these too.
    sql: `
      -- Share review C1: the connections a request's answer drew on (a chat turn's history's too), as a
      -- JSON array; NULL when not known (a chat turn kept before): such a turn is never shared.
      ALTER TABLE ai_requests ADD COLUMN sources TEXT;
      -- Share review I2: it touched a credential collection (its own, or a chat's history's).
      ALTER TABLE ai_requests ADD COLUMN credential INTEGER NOT NULL DEFAULT 0;
      UPDATE ai_requests
         SET sources = CASE WHEN connection_id IS NULL THEN '[]' ELSE json_array(connection_id) END
       WHERE action <> 'chat';
      UPDATE ai_requests SET credential = 1
       WHERE namespace IS NOT NULL
         AND substr(namespace, instr(namespace, '.') + 1)
             IN ('system.users', 'system.keys', 'system.backup_users', 'system.roles');
    `,
  },
  {
    version: 27,
    name: 'audit-retention',
    // Phase 4c §2: the log stays append-only; a delete passes only for entries older than the cut-off
    // the purge holds in this gate, written and cleared within one transaction.
    sql: `
      CREATE TABLE audit_purge (before INTEGER NOT NULL);
      DROP TRIGGER audit_log_no_delete;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        WHEN NOT EXISTS (SELECT 1 FROM audit_purge p WHERE OLD.at < p.before)
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `,
  },
  {
    version: 28,
    name: 'plugins',
    // Phase 4b §2: each plugin found or installed; enabled only while approved for these very files.
    sql: `
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('folder', 'upload', 'bundled')),
        manifest TEXT,
        digest TEXT,
        files TEXT NOT NULL DEFAULT '{}',
        bytes INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        approved_permissions TEXT NOT NULL DEFAULT '[]',
        approved_digest TEXT,
        settings TEXT NOT NULL DEFAULT '{}',
        installed_by TEXT,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 29,
    name: 'plugins_updated_from',
    // User request 2026-10-10: the version a bundled plugin was updated from (its approval kept).
    sql: `ALTER TABLE plugins ADD COLUMN updated_from TEXT;`,
  },
  {
    version: 30,
    name: 'plugins_scan',
    // User request 2026-10-11: what a plugin's files were found to try, before it is approved.
    sql: `ALTER TABLE plugins ADD COLUMN scan TEXT;`,
  },
  {
    version: 31,
    name: 'plugins_origin',
    // User request 2026-10-11: where an uploaded plugin came from (a GitHub release).
    sql: `ALTER TABLE plugins ADD COLUMN origin TEXT;`,
  },
  {
    version: 32,
    name: 'plugins_approval_carried',
    // Review 2026-10-11: whether an update kept its approval on its own, or an administrator gave it.
    // Before this, a bundled update said as updated, enabled and approved for its files was carried.
    sql: `ALTER TABLE plugins ADD COLUMN approval_carried INTEGER NOT NULL DEFAULT 0;
      UPDATE plugins SET approval_carried = 1
        WHERE source = 'bundled' AND updated_from IS NOT NULL AND enabled = 1 AND approved_digest = digest;`,
  },
  {
    version: 33,
    name: 'personal_fields_shown_locally',
    // User request 2026-10-13: in local mode a connection's personal data is hidden from the local
    // user too, unless they say to show it (1).
    sql: `ALTER TABLE personal_fields ADD COLUMN shown_locally INTEGER NOT NULL DEFAULT 0
      CHECK (shown_locally IN (0, 1));`,
  },
  {
    version: 34,
    name: 'audit_chain',
    // Security audit 2026-10-16: each entry's HMAC over the entry before it and itself (audit/audit),
    // so an entry changed, removed or added with the file in hand breaks the chain. NULL: written
    // before the chain existed.
    sql: `ALTER TABLE audit_log ADD COLUMN chain TEXT;`,
  },
  {
    version: 35,
    name: 'local_browsers',
    // Review of the audit fixes (important 1, 2): local mode's browsers — each one's cookie and page
    // key as hashes, revocable — and the launch tokens used, until they expire (single use across
    // restarts).
    sql: `
      CREATE TABLE local_browsers (
        id_hash TEXT PRIMARY KEY,
        key_hash TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT
      );
      CREATE TABLE launch_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `,
  },
  {
    version: 36,
    name: 'alerts',
    // W3.3 (completion §2): alert rules (a connection's metrics, the app's events), what fired
    // and was sent (kept after a connection goes, with its name), and the channels — the SMTP
    // server and webhooks, their password and signing secrets sealed.
    sql: `
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('metric', 'event')),
        connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
        metric TEXT,
        event TEXT,
        threshold REAL,
        slow_op_seconds INTEGER,
        sustain INTEGER NOT NULL DEFAULT 2,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        channels TEXT NOT NULL DEFAULT '{}',
        snoozed_until INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((kind = 'metric') = (metric IS NOT NULL AND connection_id IS NOT NULL)),
        CHECK ((kind = 'event') = (event IS NOT NULL))
      );
      CREATE INDEX alert_rules_connection ON alert_rules(connection_id);
      CREATE TABLE alert_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        connection_name TEXT,
        metric TEXT,
        event TEXT,
        state TEXT NOT NULL CHECK (state IN ('firing', 'resolved', 'event')),
        value REAL,
        threshold REAL,
        started_at INTEGER NOT NULL,
        resolved_at INTEGER,
        acknowledged_at INTEGER,
        acknowledged_by TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        deliveries TEXT NOT NULL DEFAULT '[]',
        snoozed INTEGER NOT NULL DEFAULT 0 CHECK (snoozed IN (0, 1))
      );
      CREATE INDEX alert_events_state ON alert_events(state);
      CREATE INDEX alert_events_started ON alert_events(started_at);
      CREATE INDEX alert_events_rule ON alert_events(rule_id, state);
      -- A rule that goes (deleted, or with its connection) leaves nothing firing for ever: what it
      -- had firing is resolved first, while the events still name it.
      CREATE TRIGGER alert_rules_gone BEFORE DELETE ON alert_rules
      BEGIN
        UPDATE alert_events SET state = 'resolved', resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE rule_id = OLD.id AND state = 'firing';
      END;
      CREATE TABLE alert_channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('smtp', 'webhook')),
        name TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 37,
    name: 'ai_agent_writes',
    // W6.3 (completion §2): whether the agentic assistant may propose changes on a connection
    // (each one still waits for the person's click). On by default; administrators turn it off.
    sql: `ALTER TABLE connections ADD COLUMN ai_agent_writes INTEGER NOT NULL DEFAULT 1
      CHECK (ai_agent_writes IN (0, 1));`,
  },
  {
    version: 38,
    name: 'destination-kinds-w4',
    // W4.5: Google Cloud Storage, Azure Blob and SFTP destinations. SQLite cannot change a CHECK in
    // place: the table is rebuilt with foreign keys off (the grants and copies pointing at it stay),
    // and the keys are checked before the migration commits.
    foreignKeysOff: true,
    rebuilt: ['backup_destinations'],
    applied: (db) =>
      /'sftp'/.test(
        (
          db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'backup_destinations'")
            .get() as { sql?: string } | undefined
        )?.sql ?? '',
      ),
    sql: `
      CREATE TABLE backup_destinations_next (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        type TEXT NOT NULL CHECK (type IN ('folder', 's3', 'gdrive', 'webdav', 'gcs', 'azure', 'sftp')),
        config TEXT NOT NULL,
        secrets TEXT,
        policy TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO backup_destinations_next SELECT id, name, type, config, secrets, policy, status, created_by,
        created_at, updated_at FROM backup_destinations;
      DROP TABLE backup_destinations;
      ALTER TABLE backup_destinations_next RENAME TO backup_destinations;
    `,
  },
  {
    version: 39,
    name: 'live-sync-lag-w4',
    applied: (db) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_sync_lag'").get() !==
      undefined,
    // W4.6: each live sync's lag, the largest of every 10 s, kept a day (bounded by the repo).
    sql: `
      CREATE TABLE live_sync_lag (
        sync_id TEXT NOT NULL REFERENCES live_syncs(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        lag_ms INTEGER NOT NULL,
        PRIMARY KEY (sync_id, at)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 40,
    name: 'transfer-files-growing-w4',
    applied: (db) =>
      (db.prepare('PRAGMA table_info(transfer_files)').all() as Array<{ name: string }>).some(
        (c) => c.name === 'growing',
      ),
    // W4 review I7: a file appended to over time (a live sync's rejected records, a Watch recording)
    // is never complete while it grows; a restart keeps it instead of taking it for a partial one.
    sql: `ALTER TABLE transfer_files ADD COLUMN growing INTEGER NOT NULL DEFAULT 0 CHECK (growing IN (0, 1));`,
  },
  {
    version: 41,
    name: 'oidc_tokens',
    // A store made before the record of applied migrations (W4) at version 41 or later, from another
    // branch, counts this as applied only if its table is there.
    applied: (db) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oidc_tokens'").get() !==
      undefined,
    // W7 (completion): each person's MONGODB-OIDC tokens per connection, sealed ('local' in local
    // mode). The issuer and client they came from are kept beside them, so they are only ever given
    // to a server that names the same identity provider.
    sql: `
      CREATE TABLE oidc_tokens (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_key TEXT NOT NULL,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        sealed TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, user_key)
      );
      CREATE INDEX oidc_tokens_user ON oidc_tokens(user_key);
    `,
  },
  {
    version: 42,
    name: 'personal_hidden_from_self',
    // User request 2026-10-24: in team mode a connection's administrator may hide its personal data
    // from themselves too ("hide from me"); a row is that choice. Local mode has no switch.
    sql: `
      CREATE TABLE personal_hidden_from_self (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (connection_id, user_id)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 43,
    name: 'ai_chat_threads',
    // User reports 2026-10-25: a chat is one entry of its owner's AI history, its turns in order (a
    // turn is still shared on its own). Numbered in one pass (review of the chat entry, M5).
    sql: `
      UPDATE ai_requests SET thread_id = chat_id, step = n.k
      FROM (SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY user_id, chat_id ORDER BY at, rowid) AS k
            FROM ai_requests WHERE action = 'chat' AND chat_id IS NOT NULL AND thread_id IS NULL) AS n
      WHERE ai_requests.rowid = n.rid;
    `,
  },
  {
    version: 44,
    name: 'ai_chat_shares_by_turn',
    // Re-review of the chat entry (M3): a chat's turn is shared on its own; a share keyed by the chat
    // itself (made while a chat was shared whole) shares nothing and goes.
    sql: `
      DELETE FROM ai_request_shares WHERE EXISTS (SELECT 1 FROM ai_requests r
        WHERE r.user_id = ai_request_shares.user_id AND r.thread_id = ai_request_shares.entry
          AND r.action = 'chat');
    `,
  },
  {
    version: 45,
    name: 'audit_log_turn_indexes',
    // Review of B6 (M3): one assistant turn's rows (the audit log's `run` filter) found through
    // indexes, never by reading the whole log — the routes' rows its calls made, and its own rows.
    sql: `
      CREATE INDEX IF NOT EXISTS audit_log_agent_run ON audit_log (json_extract(details, '$.agent.run'))
        WHERE json_extract(details, '$.agent.run') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS audit_log_ai_run ON audit_log (json_extract(details, '$.run')) WHERE action LIKE 'ai.%';
    `,
  },
  {
    version: 46,
    name: 'ai_agent_tools_off',
    // Design 2026-10-25 (C5): the agent's tools an administrator turned off on a connection (a JSON
    // list of tool names), a column of its own as the agent's writes are.
    sql: `ALTER TABLE connections ADD COLUMN ai_agent_tools_off TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 47,
    name: 'alert_reports',
    // Design 2026-10-25 (C7): scheduled reports — a connection's counts on a cadence, said through
    // the alert channels; they go with their connection. The last run's counts are kept (numbers).
    sql: `
      CREATE TABLE alert_reports (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        measures TEXT NOT NULL,
        cadence TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        channels TEXT NOT NULL DEFAULT '{}',
        next_run_at INTEGER,
        last_run TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX alert_reports_due ON alert_reports(enabled, next_run_at);
    `,
  },
  {
    version: 48,
    name: 'metric_samples_wave2',
    // Widgets wave 2 (2026-10-27): query targeting, latency, cursors, transactions and errors, kept
    // with the other metrics (numbers only). NULL where unmeasured: rows from before read as gaps.
    sql: `
      ALTER TABLE metric_samples ADD COLUMN qt_keys REAL;
      ALTER TABLE metric_samples ADD COLUMN qt_docs REAL;
      ALTER TABLE metric_samples ADD COLUMN lat_reads REAL;
      ALTER TABLE metric_samples ADD COLUMN lat_writes REAL;
      ALTER TABLE metric_samples ADD COLUMN lat_commands REAL;
      ALTER TABLE metric_samples ADD COLUMN cur_open REAL;
      ALTER TABLE metric_samples ADD COLUMN cur_no_timeout REAL;
      ALTER TABLE metric_samples ADD COLUMN tx_committed REAL;
      ALTER TABLE metric_samples ADD COLUMN tx_aborted REAL;
      ALTER TABLE metric_samples ADD COLUMN err_regular REAL;
      ALTER TABLE metric_samples ADD COLUMN err_user REAL;
      ALTER TABLE metric_samples ADD COLUMN err_msg REAL;
      ALTER TABLE metric_samples ADD COLUMN err_cursor_timeouts REAL;
    `,
  },
  {
    version: 49,
    name: 'users_require_2fa',
    // Required 2FA (2026-10-28): an administrator may require two-factor authentication of one user.
    sql: `ALTER TABLE users ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 50,
    name: 'address_bans',
    // Sign-in bans (2026-10-30): addresses refused at the team-mode sign-in, kept across restarts. A
    // row outlives its ban for a week, so an address that comes back is banned longer.
    sql: `
      CREATE TABLE address_bans (
        address TEXT PRIMARY KEY,
        reason TEXT NOT NULL CHECK (reason IN ('sign_in', 'manual')),
        strikes INTEGER NOT NULL,
        banned_at INTEGER NOT NULL,
        until INTEGER NOT NULL,
        by_user TEXT
      );
      CREATE INDEX address_bans_until ON address_bans(until);
    `,
  },
]
