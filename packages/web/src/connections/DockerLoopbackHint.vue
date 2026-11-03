<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { useConnectionCapabilities } from './capabilities'
import { DOCKER_HOST, isLoopback, withDockerHost } from './dockerHost'
import { useConnectionForm } from './formContext'

/**
 * User report 2026-11-02: in Docker, localhost is Mongo Manager's own container. Said under a test
 * that reached no server while a host is loopback (never before: a connection to localhost that works,
 * with --network host, is told nothing — second report that day), with a switch to
 * host.docker.internal for its hosts and its connection string.
 */
const { t } = useI18n()
const { form, connectionString } = useConnectionForm()
const capabilities = useConnectionCapabilities()

const shown = computed(
  () => capabilities.data.value?.distribution === 'docker' && form.hosts.some((h) => isLoopback(h.host)),
)

function useDockerHost(): void {
  for (const h of form.hosts) if (isLoopback(h.host)) h.host = DOCKER_HOST
  // The pasted string says the same, read again before Save or Test.
  const text = connectionString.text.value
  if (!text.trim()) return
  const next = withDockerHost(text)
  if (next === text) return
  connectionString.text.value = next
  connectionString.onInput()
}
</script>

<template>
  <DsCallout v-if="shown" tone="warning" data-docker-localhost>
    <span class="flex flex-col items-start gap-2">
      {{ t('connection.dockerLocalhost') }}
      <DsButton size="sm" @click="useDockerHost">{{ t('connection.dockerUseHost') }}</DsButton>
    </span>
  </DsCallout>
</template>
