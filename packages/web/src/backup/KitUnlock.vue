<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileUp, KeyRound, Lock } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { readKitFile, useKeyError } from '@/account/kit'

/**
 * Phase 3d-3c spec §5: a backup-key file none of the caller's keys opens — its recovery kit, pasted or
 * from its file (used once, not stored unless "Import this key"), or its password when it has one.
 */
const props = defineProps<{ fingerprint: string; password: boolean; error?: string | null }>()
const emit = defineEmits<{ unlock: [opener: { kit: string; importKey: boolean } | { password: string }] }>()
const { t } = useI18n()
const keyError = useKeyError()
const kitId = useId()
const kit = ref('')
const importKey = ref(false)
const pw = ref('')
const fileError = ref<string | null>(null)
/** Final review minor 14: Open with nothing given says what is missing. */
const missing = ref<string | null>(null)
watch([kit, pw], () => (missing.value = null))

async function onFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    kit.value = await readKitFile(file)
    fileError.value = null
  } catch (e) {
    fileError.value = keyError(e)
  }
}
function open(): void {
  if (kit.value.trim()) emit('unlock', { kit: kit.value, importKey: importKey.value })
  else if (props.password && pw.value) emit('unlock', { password: pw.value })
  else missing.value = t(props.password ? 'backup.unlock.missingAny' : 'backup.unlock.missingKit')
}
</script>

<template>
  <form class="flex flex-col gap-3" data-test="kit-unlock" @submit.prevent="open">
    <p class="flex items-start gap-2 text-ui text-fg">
      <KeyRound class="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden="true" />
      {{ t('backup.unlock.keyLead', { fingerprint }) }}
    </p>
    <label :for="kitId" class="text-ui font-medium text-fg">{{ t('backup.unlock.kit') }}</label>
    <textarea
      :id="kitId"
      v-model="kit"
      rows="5"
      spellcheck="false"
      autocomplete="off"
      :aria-invalid="Boolean(error || fileError)"
      :aria-describedby="`${kitId}-help`"
      class="rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-small focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
    />
    <p :id="`${kitId}-help`" class="text-small text-fg-subtle">
      {{ t('backup.unlock.kitHelp') }}
    </p>
    <div class="flex flex-wrap items-center gap-4">
      <label
        class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-ui font-medium text-fg hover:bg-subtle focus-within:ring-2 focus-within:ring-focus"
      >
        <FileUp class="size-4" aria-hidden="true" />{{ t('backup.unlock.file') }}
        <input type="file" accept=".txt,text/plain" class="sr-only" @change="onFile" />
      </label>
      <label class="flex items-center gap-2 text-ui text-fg">
        <input v-model="importKey" type="checkbox" class="size-4 accent-accent" />{{
          t('backup.unlock.import')
        }}
      </label>
    </div>
    <label v-if="password" class="flex flex-col gap-1.5 text-ui font-medium text-fg">
      <span class="flex items-center gap-1.5"
        ><Lock class="size-4" aria-hidden="true" />{{ t('backup.unlock.orPassword') }}</span
      >
      <input
        v-model="pw"
        type="password"
        autocomplete="off"
        class="h-10 rounded-lg border border-line-strong bg-surface px-3 font-mono focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
      />
    </label>
    <p v-if="error || fileError || missing" role="alert" class="text-ui text-danger">
      {{ error || fileError || missing }}
    </p>
    <DsButton type="submit" variant="primary" class="self-start">{{ t('backup.unlock.open') }}</DsButton>
  </form>
</template>
