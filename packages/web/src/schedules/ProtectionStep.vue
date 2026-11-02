<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { KeyRound, Lock } from 'lucide-vue-next'
import type { BackupFormat, BackupKeyView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import KeyCreateDialog from '@/account/KeyCreateDialog.vue'
import type { ScheduleDraft } from './useScheduleDraft'

/**
 * Spec §1.2, §3.3, §5: .mmbak with the owner's active key (or the key flow inline when there is
 * none); a plain format only when the scope and every destination allow it, with the reason when not.
 */
const props = defineProps<{
  activeKey: BackupKeyView | null
  blocked: 'encryptedOnly' | 'personal' | 'checking' | null
  encryptedOnlyNames: string[]
}>()
const emit = defineEmits<{ keyCreated: [] }>()
const draft = defineModel<ScheduleDraft>('draft', { required: true })
const { t } = useI18n()
const PLAIN = ['gzip', 'archive'] as const
const creating = ref(false)
const reason = computed(() =>
  props.blocked === 'encryptedOnly'
    ? t('schedules.editor.protection.why.encryptedOnly', { names: props.encryptedOnlyNames.join(', ') })
    : props.blocked === 'personal'
      ? t('schedules.editor.protection.why.personal')
      : props.blocked === 'checking'
        ? t('schedules.editor.protection.why.checking')
        : undefined,
)
const setFormat = (value: string) => (draft.value.format = value as BackupFormat)
</script>

<template>
  <div class="flex flex-col gap-3" role="radiogroup" :aria-label="t('schedules.editor.steps.protection')">
    <DsChoiceCard
      :model-value="draft.format"
      name="format"
      value="mmbak"
      :title="t('schedules.editor.protection.mmbak')"
      :help="t('schedules.editor.protection.mmbakHelp')"
      :badge="t('schedules.editor.protection.recommended')"
      @update:model-value="setFormat"
    />
    <div
      v-if="draft.format === 'mmbak'"
      class="ml-8 flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3 text-ui"
    >
      <template v-if="activeKey">
        <Lock class="size-4 text-success" aria-hidden="true" />
        <span class="text-fg">{{
          t('schedules.editor.protection.key', { name: activeKey.name, fingerprint: activeKey.fingerprint })
        }}</span>
      </template>
      <template v-else>
        <KeyRound class="size-4 text-warning" aria-hidden="true" />
        <span class="min-w-0 flex-1 text-fg">{{ t('schedules.editor.protection.noKey') }}</span>
        <DsButton size="sm" variant="primary" @click="creating = true">{{
          t('schedules.editor.protection.createKey')
        }}</DsButton>
      </template>
    </div>
    <DsChoiceCard
      v-for="f in PLAIN"
      :key="f"
      :model-value="draft.format"
      name="format"
      :value="f"
      :title="t(`schedules.editor.protection.${f}`)"
      :help="t('schedules.editor.protection.plainHelp')"
      :disabled="blocked !== null"
      :reason="reason"
      @update:model-value="setFormat"
    />
    <KeyCreateDialog v-if="creating" @close="creating = false" @done="emit('keyCreated')" />
  </div>
</template>
