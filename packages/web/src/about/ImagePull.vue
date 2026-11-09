<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RELEASE_IMAGE } from '@mongo-manager/shared/browser'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'

/**
 * How a Docker install gets a newer image, for both ways it is run (user report 2026-11-09: the
 * panel showed Compose's command alone to a container started with docker run).
 */
const props = defineProps<{ version: string }>()
const { t } = useI18n()
const pull = computed(() => `docker pull ${RELEASE_IMAGE}:${props.version}`)
</script>

<template>
  <div class="flex flex-col gap-3" data-image-pull>
    <div class="flex flex-col gap-1.5" data-pull-compose>
      <p class="text-small font-semibold text-fg">{{ t('about.updates.compose') }}</p>
      <DsCodeBlock code="docker compose pull && docker compose up -d" :copy-label="t('about.updates.copy')" />
    </div>
    <div class="flex flex-col gap-1.5" data-pull-run>
      <p class="text-small font-semibold text-fg">{{ t('about.updates.dockerRun') }}</p>
      <DsCodeBlock :code="pull" :copy-label="t('about.updates.copy')" />
      <p class="text-small text-fg-muted">{{ t('about.updates.runAgain') }}</p>
    </div>
  </div>
</template>
