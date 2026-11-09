// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * W7: the connection that needs this person's OIDC sign-in (the API said so), shown by the sign-in
 * dialog (OidcSignInHost) — one at a time; a second request while it is open changes nothing.
 */
export const useOidcSignInStore = defineStore('oidcSignIn', () => {
  const connectionId = ref<string | null>(null)
  function request(id: string): void {
    if (!connectionId.value) connectionId.value = id
  }
  function close(): void {
    connectionId.value = null
  }
  return { connectionId, request, close }
})
