<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Download } from 'lucide-vue-next'
import {
  toCSharp,
  toGo,
  toJsonSchema,
  toMongoose,
  toPydantic,
  toTypeScript,
  typeName,
} from '@mongo-manager/shared/browser'
import type { SchemaAnalysis } from '@mongo-manager/shared'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCodeView from '@/ds/DsCodeView.vue'
import { downloadText } from '@/download'
import { useToastStore } from '@/stores/toasts'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * Schema export (phase 1i spec §6): generated here in the browser, shown as text, copied or saved.
 * Nothing is evaluated.
 */
const props = defineProps<{ analysis: SchemaAnalysis; coll: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toasts = useToastStore()

/** Plugins wave 1: Pydantic, Go and C# beside the formats of phase 1i. */
type Format = 'mongoose' | 'jsonSchema' | 'typescript' | 'pydantic' | 'go' | 'csharp'
const format = ref<Format>('mongoose')

const source = computed(() => {
  switch (format.value) {
    case 'jsonSchema':
      return `${JSON.stringify(toJsonSchema(props.analysis), null, 2)}\n`
    case 'typescript':
      return toTypeScript(props.analysis, props.coll)
    case 'pydantic':
      return toPydantic(props.analysis, props.coll)
    case 'go':
      return toGo(props.analysis, props.coll)
    case 'csharp':
      return toCSharp(props.analysis, props.coll)
    default:
      return toMongoose(props.analysis, props.coll)
  }
})
const filename = computed(() => {
  const base = props.coll.replace(/[^\w.-]+/g, '_')
  switch (format.value) {
    case 'jsonSchema':
      return `${base}.schema.json`
    case 'typescript':
      return `${base}.ts`
    case 'pydantic':
      return `${base}_model.py`
    case 'go':
      return `${base}_model.go`
    case 'csharp':
      return `${typeName(props.coll)}.cs`
    default:
      return `${base}.model.js`
  }
})

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(source.value)
    toasts.push({ kind: 'success', message: t('schema.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('schema.copyFailed') })
  }
}
</script>

<template>
  <DsDialog open :title="t('schema.exportTitle')" size="lg" @close="emit('close')">
    <div class="flex flex-col gap-3">
      <DsSelect
        v-model="format"
        class="w-56"
        :label="t('schema.format')"
        :options="
          (['mongoose', 'jsonSchema', 'typescript', 'pydantic', 'go', 'csharp'] as const).map((f) => ({
            value: f,
            label: t(`schema.formats.${f}`),
          }))
        "
      />
      <p class="text-small text-fg-subtle">{{ t('schema.exportHint') }}</p>
      <div class="max-h-[50vh] overflow-auto rounded-md border border-line bg-subtle p-3">
        <DsCodeView :text="source" />
      </div>
    </div>
    <template #footer>
      <DsButton @click="copy()">
        <Copy class="size-4" aria-hidden="true" />
        {{ t('schema.copy') }}
      </DsButton>
      <DsButton variant="primary" @click="downloadText(source, filename)">
        <Download class="size-4" aria-hidden="true" />
        {{ t('schema.download') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
