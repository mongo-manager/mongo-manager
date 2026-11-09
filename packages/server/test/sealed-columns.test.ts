// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const path = join(dir, f)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })

/**
 * Key rotation (crypto/rotate.ts) re-encrypts exactly connections.settings, users.totp_secret,
 * query_history.body (and re-keys body_hash), saved_queries.query, saved_pipelines.pipeline
 * (phase 2c), shell_history.code (and re-keys code_hash, phase 3a-1), snippets.body (phase 3a-2),
 * personal_fields.rules (phase 3b), transfer_presets.body (phase 3d-1) and live_syncs.place (phase 3e-2).
 * Recent queries of phase
 * 1g-1 are moved into query_history before it starts.
 * A new place that seals a secret must be added to the rotation, or the next rotation makes it
 * unreadable: this test fails until the list below is updated together with rotate.ts.
 */
const KNOWN_SEAL_SITES = [
  // Phase 4a-2: chat titles and messages (rotate.ts re-seals ai_chats.title and ai_chat_messages.body).
  'ai/chats.ts',
  // Phase 4a-1: AI providers' keys (rotate.ts re-seals ai_providers.api_key).
  'ai/providers.ts',
  // User review 2026-10-09: the AI history's words (rotate.ts re-seals ai_requests.content).
  'ai/requests.ts',
  // W3.3: the SMTP password and webhook signing secrets (rotate.ts re-seals alert_channels.secret).
  'alerts/repo.ts',
  // Phase 3d-3b: destination secrets and resume states (rotate.ts re-seals both).
  'backup/destinations/repo.ts',
  // Phase 3d-3c: users' backup keys (rotate.ts re-seals backup_keys.sealed_key).
  'backup/keys/repo.ts',
  'connections/repo.ts',
  // Security audit 2026-10-16: the recovery-code and audit-chain keys (rotate.ts re-seals them).
  'crypto/app-keys.ts',
  'crypto/rotate.ts',
  // Phase 3e-2: live syncs' places (rotate.ts re-seals live_syncs.place).
  'livesync/repo.ts',
  'masking/repo.ts',
  // W7: people's OIDC tokens (rotate.ts re-seals oidc_tokens.sealed).
  'oidc/tokens.ts',
  // Security audit 2026-10-16: a plugin frame ticket's session, sealed with a key derived from the
  // frame key — never stored; a rotation changes that key, which ends every ticket (a page loaded
  // again gets a new one).
  'plugins/frame.ts',
  // Security audit 2026-10-16: plugins' settings (rotate.ts re-seals plugins.settings).
  'plugins/repo.ts',
  'queries/history.ts',
  'queries/sealed-items.ts',
  'queries/snippets.ts',
  'routes/auth.ts',
  'shell/history.ts',
  'transfer/presets.ts',
]

describe('sealed secrets are all covered by key rotation', () => {
  it('seal() is only called where rotation knows about it', () => {
    const sites = files(SRC)
      .filter((f) => !f.endsWith(join('crypto', 'secret-box.ts')))
      .filter((f) => /\.seal\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort()
    expect(sites).toEqual(KNOWN_SEAL_SITES)
  })
})
