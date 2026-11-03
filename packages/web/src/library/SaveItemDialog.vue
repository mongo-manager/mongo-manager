<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { useSessionStore } from '@/stores/session'
import { parseTags, tagError } from './tags'

/** Phase 2c: a name, tags and sharing for a favourite or a saved pipeline, new or changed. */
const props = defineProps<{
  title: string
  message?: string
  name?: string
  tags?: string[]
  shared?: boolean
  busy?: boolean
  /** Why the last save failed, shown in the dialog (final review 2c, Minor 13). */
  error?: string
}>()
const emit = defineEmits<{ save: [item: { name: string; tags: string[]; shared: boolean }]; close: [] }>()
const { t } = useI18n()
const session = useSessionStore()
/** Sharing means something only with a team (final review 2c, Minor 13). */
const canShare = computed(() => session.status?.mode === 'team')

const name = ref(props.name ?? '')
const tags = ref((props.tags ?? []).join(', '))
const shared = ref(props.shared ?? false)
const nameError = ref('')
const tagsError = ref('')

function submit(): void {
  if (props.busy) return
  nameError.value = name.value.trim() ? '' : t('library.nameRequired')
  const parsed = parseTags(tags.value)
  tagsError.value = tagError(t, parsed)
  if (nameError.value || tagsError.value) return
  emit('save', { name: name.value.trim(), tags: parsed.tags, shared: canShare.value && shared.value })
}
</script>

<template>
  <DsDialog open :title="title" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <p v-if="message" class="text-ui text-fg-muted">{{ message }}</p>
      <DsInput
        v-model="name"
        :label="t('library.name')"
        :error="nameError"
        :maxlength="100"
        autocomplete="off"
        required
      />
      <DsInput
        v-model="tags"
        :label="t('library.tags')"
        :hint="t('library.tagsHint')"
        :error="tagsError"
        autocomplete="off"
      />
      <DsCheckbox
        v-if="canShare"
        v-model="shared"
        :label="t('library.share')"
        :hint="t('library.shareHint')"
      />
      <DsFormErrors :messages="error ? [error] : []" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" @click="submit">{{ t('library.save') }}</DsButton>
    </template>
  </DsDialog>
</template>
