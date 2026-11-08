<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  SnippetBodySchema,
  SnippetUpdateSchema,
  placeholdersOf,
  type ParamType,
  type SnippetParam,
  type SnippetView,
} from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { snippetsApi } from '@/api/snippets'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { parseTags, tagError } from '@/library/tags'
import { saveError } from '@/library/errors'
import DsSelect from '@/ds/DsSelect.vue'

/** A saved snippet as the Library gives it, to edit (W5). */
export interface EditedSnippet {
  id: string
  name: string
  tags: string[]
  code: string
  params: SnippetParam[]
  shared: boolean
}

/**
 * Phase 3a-2 spec §3.5: save shell code as a snippet. A parameter row follows each {{name}} in the
 * code (type, optional default, required); the form is checked with the server's own schema before
 * it is sent, so an invalid default shows beside its field. W5: with `snippet`, a saved one is
 * edited — its code too, the parameter rows following its placeholders as it is typed.
 */
const props = defineProps<{ connectionId: string; code: string; snippet?: EditedSnippet }>()
const emit = defineEmits<{ saved: [snippet: SnippetView]; close: [] }>()
const { t } = useI18n()
const session = useSessionStore()
const toasts = useToastStore()
const id = useId()
/** Sharing means something only with a team (as for favourites). */
const canShare = computed(() => session.status?.mode === 'team')
const editing = computed(() => props.snippet !== undefined)

const TYPES: ParamType[] = ['string', 'number', 'boolean', 'ejson']
/** Shown in the hint; a template cannot hold the braces literally. */
const PLACEHOLDER_EXAMPLE = '{{name}}'
type Row = { name: string; type: ParamType; default: string; required: boolean }
const toRow = (p: SnippetParam): Row => ({
  name: p.name,
  type: p.type,
  default: p.default ?? '',
  required: p.required ?? false,
})
const code = ref(props.snippet?.code ?? props.code)
const params = ref<Row[]>(
  props.snippet
    ? props.snippet.params.map(toRow)
    : placeholdersOf(props.code).map((name) => ({ name, type: 'string', default: '', required: false })),
)
// W5: the rows follow the placeholders of the code being edited; a parameter kept keeps its settings.
// Review (minor): a parameter whose placeholder is typed over (deleted, then written again) keeps its
// settings while the dialog is open — every row seen is remembered, not only the ones shown.
const remembered = new Map<string, Row>()
watch(code, (text) => {
  for (const p of params.value) remembered.set(p.name, p)
  params.value = placeholdersOf(text).map(
    (name) => remembered.get(name) ?? { name, type: 'string', default: '', required: false },
  )
})
const name = ref(props.snippet?.name ?? '')
const tags = ref(props.snippet?.tags.join(', ') ?? '')
const shared = ref(props.snippet?.shared ?? false)
const nameError = ref('')
const tagsError = ref('')
const codeError = ref('')
const paramErrors = ref<Record<number, string>>({})
const formError = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (busy.value) return
  nameError.value = name.value.trim() ? '' : t('library.nameRequired')
  const parsed = parseTags(tags.value)
  tagsError.value = tagError(t, parsed)
  paramErrors.value = {}
  codeError.value = ''
  formError.value = ''
  const body = {
    name: name.value.trim(),
    tags: parsed.tags,
    code: code.value,
    params: params.value.map((p) => ({
      name: p.name,
      type: p.type,
      ...(p.default !== '' ? { default: p.default } : {}),
      required: p.required,
    })),
    // Without a team there is no one to share with; an edit keeps what the snippet was.
    shared: canShare.value ? shared.value : (props.snippet?.shared ?? false),
  }
  const checked = (editing.value ? SnippetUpdateSchema : SnippetBodySchema).safeParse(body)
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      if (issue.path[0] === 'params' && typeof issue.path[1] === 'number')
        paramErrors.value = { ...paramErrors.value, [issue.path[1]]: issue.message }
      else if (issue.path[0] === 'name') nameError.value ||= issue.message
      else if (issue.path[0] === 'code' && editing.value) codeError.value ||= issue.message
      else formError.value ||= issue.message
    }
  }
  if (nameError.value || tagsError.value || !checked.success) return
  busy.value = true
  try {
    const saved = props.snippet
      ? await snippetsApi.update(props.connectionId, props.snippet.id, body)
      : await snippetsApi.create(props.connectionId, body)
    toasts.push({ kind: 'success', message: t('shell.snippets.saved') })
    emit('saved', saved)
  } catch (e) {
    formError.value = saveError(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <DsDialog
    open
    :title="editing ? t('library.editSnippet') : t('shell.snippets.saveTitle')"
    size="md"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
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
      <DsTextarea
        v-if="editing"
        v-model="code"
        data-snippet-code
        mono
        :rows="6"
        :label="t('shell.snippets.code')"
        :hint="t('shell.snippets.codeHint', { placeholder: PLACEHOLDER_EXAMPLE })"
        :error="codeError"
      />
      <div v-else class="flex flex-col gap-1">
        <span class="text-ui font-medium text-fg">{{ t('shell.snippets.code') }}</span>
        <pre
          class="max-h-40 overflow-auto rounded-lg bg-subtle p-2 font-mono text-small whitespace-pre-wrap"
          >{{ code }}</pre>
      </div>
      <fieldset v-if="params.length" class="flex flex-col gap-2">
        <legend class="text-ui font-medium text-fg">
          {{ t('shell.snippets.params') }}
        </legend>
        <p class="text-small text-fg-subtle">
          {{ t('shell.snippets.paramsHint', { placeholder: PLACEHOLDER_EXAMPLE }) }}
        </p>
        <div
          v-for="(p, i) in params"
          :key="p.name"
          class="flex flex-col gap-1 rounded-lg border border-line p-2"
          :data-param-row="p.name"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-ui">{{ p.name }}</span>
            <DsSelect
              v-model="p.type"
              class="w-32"
              hide-label
              :label="t('shell.snippets.type', { name: p.name })"
              :options="TYPES.map((type) => ({ value: type, label: t(`shell.snippets.types.${type}`) }))"
            />
            <label class="sr-only" :for="`${id}-default-${i}`">{{
              t('shell.snippets.default', { name: p.name })
            }}</label>
            <input
              :id="`${id}-default-${i}`"
              v-model="p.default"
              data-param-default
              :placeholder="t('shell.snippets.defaultPlaceholder')"
              class="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 font-mono text-ui"
              :aria-invalid="paramErrors[i] ? 'true' : undefined"
              :aria-describedby="paramErrors[i] ? `${id}-error-${i}` : undefined"
            />
            <label class="inline-flex items-center gap-1 text-ui">
              <input v-model="p.required" type="checkbox" />
              {{ t('shell.snippets.required') }}
            </label>
          </div>
          <p v-if="paramErrors[i]" :id="`${id}-error-${i}`" class="text-small text-danger">
            {{ paramErrors[i] }}
          </p>
        </div>
      </fieldset>
      <DsFormErrors :messages="formError ? [formError] : []" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" @click="submit">{{ t('library.save') }}</DsButton>
    </template>
  </DsDialog>
</template>
