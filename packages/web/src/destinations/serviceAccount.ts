// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * A Google service account key's e-mail, read only to name the account back — null when the text is
 * not such a key. The key itself is never shown (it holds a private key).
 */
export function serviceAccountEmail(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { type?: string; client_email?: unknown; private_key?: unknown }
    return parsed.type === 'service_account' &&
      typeof parsed.client_email === 'string' &&
      parsed.client_email &&
      typeof parsed.private_key === 'string'
      ? parsed.client_email
      : null
  } catch {
    return null
  }
}
