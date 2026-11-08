<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import ShellWorkspace from '@/shell/ShellWorkspace.vue'

/**
 * Phase 3a-1/3a-2: a shell tab. The key ties one shell (terminal, session, results) to one
 * connection/database.
 */
defineProps<{ connectionId: string; db: string; tabId?: string }>()
</script>

<template>
  <ShellWorkspace :key="`${connectionId}/${db}`" :connection-id="connectionId" :db="db" :tab-id="tabId" />
</template>
