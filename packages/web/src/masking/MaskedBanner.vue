<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'

/**
 * Phase 3c §7 (W5: on every data screen): some values here are hidden from this user. `wide`: a
 * screen over more than one collection (a database or deployment watch).
 */
defineProps<{ wide?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <p data-masked-banner class="flex items-center gap-1.5 text-small text-fg-subtle">
    <Lock class="size-3.5 shrink-0" aria-hidden="true" />{{
      t(wide ? 'masking.bannerWide' : 'masking.banner')
    }}
  </p>
</template>
