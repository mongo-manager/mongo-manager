<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CloudCheck, CloudOff, FileArchive, Info, RotateCcw, Send } from 'lucide-vue-next'
import type { BackupView } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { backupKeys } from '@/api/backup'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { useJobsStore } from '@/jobs/store'
import { useToastStore } from '@/stores/toasts'
import WhereSection from './WhereSection.vue'
import { useBackupError } from './checkText'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * Phase 3d-3b §1.2 step 2, V6: send a kept backup to destinations from its row. Final review C7: the
 * list loads, may be empty or fail, and says so; a kept backup cannot be re-encrypted, so a
 * destination that wants encrypted backups says why instead of offering a fix that does nothing.
 */
const props = defineProps<{ backup: BackupView }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const jobs = useJobsStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const backupError = useBackupError()
const destinationsQuery = useQuery({
  queryKey: destinationKeys.mine,
  queryFn: () => destinationsApi.mine(),
})
// Already sent there: not offered again.
const sentTo = new Set(props.backup.copies.filter((c) => c.state === 'complete').map((c) => c.destinationId))
const all = computed(() => destinationsQuery.data.value ?? [])
const offered = computed(() => all.value.filter((d) => !sentTo.has(d.id)))
const chosen = ref<string[]>([])
const deleteLocal = ref(false)
const busy = ref(false)
const errors = ref<string[]>([])
// The server holds the rule for personal data; an unencrypted, unmasked backup is treated as personal here.
const plainPersonal = !props.backup.masked && !props.backup.anonymous && props.backup.format !== 'mmbak'
/** Some destination wants an encrypted backup and this one is not: it can only be dumped again, encrypted. */
const needsEncrypted = computed(
  () => props.backup.format !== 'mmbak' && offered.value.some((d) => d.policy.encryptedOnly || plainPersonal),
)

async function send(): Promise<void> {
  if (!chosen.value.length || busy.value) return
  busy.value = true
  errors.value = []
  try {
    const { job } = await destinationsApi.send(props.backup.id, {
      destinationIds: chosen.value,
      deleteLocal: deleteLocal.value,
    })
    jobs.upsert(job)
    toasts.push({ kind: 'info', message: t('backup.send.started') })
    await queryClient.invalidateQueries({ queryKey: backupKeys.all })
    emit('close')
  } catch (e) {
    errors.value = backupError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog open :title="t('backup.send.title')" size="md" @close="emit('close')">
    <div class="flex flex-col gap-4">
      <div class="flex min-w-0 items-start gap-3">
        <FileArchive class="mt-0.5 size-5 shrink-0 text-accent-fg" aria-hidden="true" />
        <div class="min-w-0">
          <p class="truncate font-mono text-ui text-fg" :title="backup.name">
            {{ backup.name }}
          </p>
          <p class="text-ui text-fg-subtle">{{ t('backup.send.lead') }}</p>
        </div>
      </div>
      <DsFormErrors :messages="errors" />
      <div v-if="destinationsQuery.isPending.value" class="flex flex-wrap gap-2" aria-busy="true">
        <DsSkeleton v-for="n in 3" :key="n" class="h-8 w-28 rounded-full" />
      </div>
      <DsCallout v-else-if="destinationsQuery.isError.value" tone="danger">
        {{ backupError(destinationsQuery.error.value).join(' ') }}
        <template #action>
          <DsButton
            size="sm"
            :icon="RotateCcw"
            :loading="destinationsQuery.isFetching.value"
            @click="destinationsQuery.refetch()"
            >{{ t('common.retry') }}</DsButton
          >
        </template>
      </DsCallout>
      <div
        v-else-if="!offered.length"
        role="status"
        class="flex items-start gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3 text-ui text-fg-muted"
      >
        <component
          :is="all.length ? CloudCheck : CloudOff"
          class="mt-0.5 size-4 shrink-0 text-fg-subtle"
          aria-hidden="true"
        />
        <span>{{ all.length ? t('backup.send.allSent') : t('backup.send.none') }}</span>
      </div>
      <template v-else>
        <WhereSection
          v-model="chosen"
          v-model:delete-local="deleteLocal"
          :destinations="offered"
          :format="backup.format"
          :plain-personal="plainPersonal"
          no-fix
        />
        <p
          v-if="needsEncrypted"
          class="flex items-start gap-2 rounded-xl bg-subtle px-3 py-2 text-ui text-fg-muted"
        >
          <Info class="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />{{
            t('backup.send.cannotEncrypt')
          }}
        </p>
      </template>
    </div>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :disabled="!chosen.length" :loading="busy" @click="send">
        <Send class="size-4" aria-hidden="true" />{{ t('backup.send.send') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
