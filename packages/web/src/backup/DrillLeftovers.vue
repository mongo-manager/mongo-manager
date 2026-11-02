<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Trash2 } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { backupApi } from '@/api/backup'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'

/**
 * W4 re-review (minor): a restore drill's scratch database that could not be dropped, said to the
 * connection's admins with a way to drop it — by its typed name, never while a drill runs. Nothing
 * shows while there is none.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const key = computed(() => ['backup', 'drill-leftovers', props.connectionId])
const leftovers = useQuery({ queryKey: key, queryFn: () => backupApi.drillLeftovers(props.connectionId) })
const items = computed(() => leftovers.data.value?.databases ?? [])

async function drop(name: string): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('backup.drill.leftovers.dropTitle', { name }),
    message: t('backup.drill.leftovers.dropHelp'),
    confirmLabel: t('backup.drill.leftovers.drop'),
    danger: true,
    requireText: name,
  })
  if (!ok) return
  try {
    await backupApi.dropDrillLeftover(props.connectionId, name)
    toasts.push({ kind: 'success', message: t('backup.drill.leftovers.dropped', { name }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    await queryClient.invalidateQueries({ queryKey: key.value })
  }
}
</script>

<template>
  <DsCallout
    v-if="items.length"
    tone="warning"
    :title="t('backup.drill.leftovers.title')"
    data-drill-leftovers
  >
    <p class="text-small">{{ t('backup.drill.leftovers.help') }}</p>
    <ul class="mt-2 flex flex-col gap-1.5">
      <li v-for="d in items" :key="d.name" class="flex flex-wrap items-center gap-2" data-drill-leftover>
        <span class="font-mono text-small break-all">{{ d.name }}</span>
        <span class="text-small text-fg-subtle tabular-nums">{{ formatBytes(d.sizeOnDisk, locale) }}</span>
        <DsButton
          size="sm"
          variant="secondary"
          class="ml-auto"
          :disabled="leftovers.data.value?.running"
          :title="leftovers.data.value?.running ? t('backup.drill.leftovers.running') : undefined"
          @click="drop(d.name)"
          ><Trash2 class="size-4" aria-hidden="true" />{{ t('backup.drill.leftovers.dropMenu') }}</DsButton
        >
      </li>
    </ul>
    <p v-if="leftovers.data.value?.running" class="mt-1 text-small text-fg-muted">
      {{ t('backup.drill.leftovers.running') }}
    </p>
  </DsCallout>
</template>
