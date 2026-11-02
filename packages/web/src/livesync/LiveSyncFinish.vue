<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, Hand, ScanSearch } from 'lucide-vue-next'
import type { LiveSyncView } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
/** Spec §1.6: the cutover — stop writes, everything up to now is applied, verify (on by default), done. */
defineProps<{ sync: LiveSyncView; busy: boolean }>()
const emit = defineEmits<{ close: []; finish: [verify: boolean] }>()
const { t } = useI18n()
const verify = ref(true)
const STEPS = [
  { key: 'stop', icon: Hand },
  { key: 'apply', icon: CircleCheck },
  { key: 'verify', icon: ScanSearch },
] as const
</script>

<template>
  <DsDialog open :title="t('liveSync.finish.title', { name: sync.name })" size="md" @close="emit('close')">
    <ol class="flex flex-col gap-3">
      <li v-for="(s, i) in STEPS" :key="s.key" class="flex gap-3 text-ui">
        <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft">
          <component :is="s.icon" class="size-4 text-accent-fg" aria-hidden="true" />
        </span>
        <span>
          <span class="font-medium text-fg">{{ i + 1 }}. {{ t(`liveSync.finish.${s.key}.title`) }}</span>
          <span class="block text-fg-muted">{{ t(`liveSync.finish.${s.key}.help`) }}</span>
        </span>
      </li>
    </ol>
    <label class="mt-4 flex items-center gap-2 text-ui">
      <input v-model="verify" type="checkbox" class="size-4 accent-accent" />
      {{ t('liveSync.finish.verifyAfter') }}
    </label>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" @click="emit('finish', verify)">{{
        t('liveSync.finish.confirm')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
