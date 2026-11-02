<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clipboard, Download, Printer, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import type { BackupKeyCreated } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { keysApi } from '@/api/schedules'
import { downloadText } from '@/download'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useKeyError } from './kit'

/**
 * Phase 3d-3c spec §5: what a kit is → the kit, shown once, with Download, Print and Copy → its last
 * group typed back. The kit leaves memory with the dialog; nothing shows a key after confirmation.
 */
/** Final review minor 11: `pending` opens a key whose kit was never confirmed straight at its last step. */
const props = defineProps<{ rotate?: boolean; pending?: { id: string; name: string } }>()
const emit = defineEmits<{ close: []; done: [name: string] }>()
const { t } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const keyError = useKeyError()
type Step = 'intro' | 'kit' | 'confirm'
const STEPS: Step[] = ['intro', 'kit', 'confirm']
const step = ref<Step>(props.pending ? 'confirm' : 'intro')
const name = ref('')
const created = ref<BackupKeyCreated | null>(null)
const saved = ref(false)
const check = ref('')
const busy = ref(false)
const errors = ref<string[]>([])
const keyId = computed(() => created.value?.key.id ?? props.pending?.id ?? null)
const keyName = computed(() => created.value?.key.name ?? props.pending?.name ?? '')
// Final review minor 14: a new step takes the focus (the button that led there is gone).
const body = ref<HTMLElement | null>(null)
watch(step, async () => {
  await nextTick()
  body.value?.querySelector<HTMLElement>('input:not([type="checkbox"]), button')?.focus()
})
const title = computed(() => (props.rotate ? t('keys.createFlow.rotateTitle') : t('keys.createFlow.title')))

async function create(): Promise<void> {
  busy.value = true
  errors.value = []
  try {
    created.value = await keysApi.create(name.value.trim() || undefined)
    step.value = 'kit'
  } catch (e) {
    errors.value = [keyError(e)]
  } finally {
    busy.value = false
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(created.value!.kit)
    toasts.push({ kind: 'success', message: t('keys.createFlow.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('documents.copyFailed') })
  }
}
/** The print stylesheet shows the kit alone (`[data-print]`, assets/main.css). */
const print = () => window.print()

async function confirm(): Promise<void> {
  if (!keyId.value || !check.value.trim()) return
  busy.value = true
  errors.value = []
  try {
    await keysApi.confirm(keyId.value, check.value.trim())
    toasts.push({ kind: 'success', message: t('keys.createFlow.done', { name: keyName.value }) })
    emit('done', keyName.value)
    finish()
  } catch (e) {
    errors.value = [keyError(e)]
  } finally {
    busy.value = false
  }
}

function finish(): void {
  created.value = null
  check.value = ''
  emit('close')
}

/** Leaving after the kit was shown leaves an unusable key: the user is asked first. */
async function leave(): Promise<void> {
  // Nothing new was shown when it began at its last step: leaving loses nothing.
  if (step.value === 'intro' || props.pending) return finish()
  const ok = await dialogs.confirm({
    title: t('keys.createFlow.leaveTitle'),
    message: t('keys.createFlow.leaveHelp'),
    confirmLabel: t('keys.createFlow.leave'),
    danger: true,
  })
  if (ok) finish()
}
</script>

<template>
  <DsDialog open persistent :title="title" size="lg">
    <ol class="mb-5 flex flex-wrap gap-2 text-small" :aria-label="t('keys.createFlow.stepsLabel')">
      <li
        v-for="(s, i) in STEPS"
        :key="s"
        :aria-current="s === step ? 'step' : undefined"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1"
        :class="s === step ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-subtle'"
      >
        <span class="tabular-nums">{{ i + 1 }}</span>
        {{ t(`keys.createFlow.steps.${s}`) }}
      </li>
    </ol>

    <div ref="body">
      <div v-if="step === 'intro'" class="flex flex-col gap-4 text-ui">
        <p class="text-fg">
          {{ rotate ? t('keys.rotateLead') : t('keys.createFlow.introLead') }}
        </p>
        <ul class="flex flex-col gap-2">
          <li v-for="p in ['point1', 'point2', 'point3']" :key="p" class="flex gap-2 text-fg">
            <ShieldCheck class="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden="true" />
            {{ t(`keys.createFlow.${p}`) }}
          </li>
        </ul>
        <DsInput
          v-model="name"
          :label="t('keys.createFlow.name')"
          :placeholder="t('keys.createFlow.namePlaceholder')"
          :maxlength="64"
        />
      </div>

      <div v-else-if="step === 'kit' && created" class="flex flex-col gap-3 text-ui">
        <p
          role="note"
          class="flex gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{
            t('keys.createFlow.kitLead')
          }}
        </p>
        <pre
          data-print
          data-test="kit"
          class="max-h-72 overflow-auto rounded-lg border border-line bg-subtle p-4 font-mono text-small leading-relaxed whitespace-pre-wrap text-fg select-all"
          >{{ created.kit }}</pre>
        <div class="flex flex-wrap gap-2">
          <DsButton size="sm" variant="primary" @click="downloadText(created.kit, created.fileName)"
            ><Download class="size-4" aria-hidden="true" />{{ t('keys.createFlow.download') }}</DsButton
          >
          <DsButton size="sm" @click="print"
            ><Printer class="size-4" aria-hidden="true" />{{ t('keys.createFlow.print') }}</DsButton
          >
          <DsButton size="sm" variant="ghost" @click="copy"
            ><Clipboard class="size-4" aria-hidden="true" />{{ t('keys.createFlow.copy') }}</DsButton
          >
        </div>
        <!-- Final review minor 15: a copied kit can outlive this dialog. -->
        <p class="text-small text-fg-subtle">{{ t('keys.createFlow.copyWarning') }}</p>
        <label class="flex items-center gap-2 text-fg">
          <input v-model="saved" type="checkbox" class="size-4 accent-accent" />{{
            t('keys.createFlow.saved')
          }}
        </label>
      </div>

      <form v-else id="key-confirm" class="flex flex-col gap-3 text-ui" @submit.prevent="confirm">
        <p class="text-fg">{{ t('keys.createFlow.confirmLead') }}</p>
        <!-- UI review: a short code gets a short field, like the sign-in codes. -->
        <div class="max-w-56">
          <DsInput
            v-model="check"
            :label="t('keys.createFlow.check')"
            mono
            autocomplete="off"
            :maxlength="9"
            required
          />
        </div>
      </form>
    </div>

    <DsFormErrors v-if="errors.length" class="mt-3" :messages="errors" />

    <template #footer>
      <DsButton variant="ghost" class="mr-auto" @click="leave">{{ t('common.cancel') }}</DsButton>
      <DsButton v-if="step === 'intro'" variant="primary" :loading="busy" @click="create">{{
        t('keys.create')
      }}</DsButton>
      <DsButton v-else-if="step === 'kit'" variant="primary" :disabled="!saved" @click="step = 'confirm'">{{
        t('keys.createFlow.next')
      }}</DsButton>
      <DsButton v-else type="submit" form="key-confirm" variant="primary" :loading="busy">{{
        t('keys.createFlow.confirm')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
