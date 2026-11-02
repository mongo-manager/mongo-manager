<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DATA_OPS,
  SCHEMA_OPS,
  WatchOptionsSchema,
  formatShell,
  deserializeValue,
  parseQueryObject,
  serializeValue,
  type WatchOptions,
  type WatchScope,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import type { WatchFeed } from './feeds'
import { useWatchWords } from './words'

const props = defineProps<{
  feed: WatchFeed
  scope: WatchScope
  open: boolean
  /** W4.7: the viewer may export from the connection: a recording is offered. */
  canRecord?: boolean
}>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const { t } = useI18n()
const words = useWatchWords()

const text = ref(
  Object.keys(props.feed.filter.value).length > 0
    ? formatShell(deserializeValue(props.feed.filter.value))
    : '',
)
const parseError = ref<string | null>(null)
/** A refusal of the filter (by MongoDB, the server's checks or masking) is shown here, at the editor. */
const refused = computed(() =>
  props.feed.status.value === 'refused' &&
  ['filter', 'masking_filter', 'internal'].includes(props.feed.reason.value ?? '')
    ? words.reason(props.feed)
    : null,
)
watch(refused, (r) => r && emit('update:open', true), { immediate: true })

const shownOps = computed(() =>
  props.feed.options.value.schemaChanges ? [...DATA_OPS, ...SCHEMA_OPS] : [...DATA_OPS],
)
const on = (op: string) => props.feed.options.value.ops.includes(op as never)

function apply(next: Partial<WatchOptions>, filter = props.feed.filter.value): void {
  props.feed.configure(filter, WatchOptionsSchema.parse({ ...props.feed.options.value, ...next }))
}
function toggle(op: string): void {
  const ops = on(op)
    ? props.feed.options.value.ops.filter((o) => o !== op)
    : [...props.feed.options.value.ops, op]
  if (ops.length === 0) return
  apply({ ops: ops as WatchOptions['ops'] })
}
function setSchema(value: boolean): void {
  const ops = value
    ? [...new Set([...props.feed.options.value.ops, ...SCHEMA_OPS])]
    : props.feed.options.value.ops.filter((o) => (DATA_OPS as readonly string[]).includes(o))
  apply({ schemaChanges: value, ops: (ops.length > 0 ? ops : [...DATA_OPS]) as WatchOptions['ops'] })
}
function applyText(): void {
  try {
    const filter = serializeValue(parseQueryObject(text.value)) as Record<string, unknown>
    parseError.value = null
    apply({}, filter)
  } catch (e) {
    parseError.value = t('watch.filter.invalid', { message: e instanceof Error ? e.message : String(e) })
  }
}
const EXAMPLES = computed(() => [
  { label: t('watch.filter.example.paid'), text: "{ 'updateDescription.updatedFields.status': 'paid' }" },
  { label: t('watch.filter.example.oneDocument'), text: "{ 'documentKey._id': ObjectId('…') }" },
  ...(props.scope !== 'collection'
    ? [{ label: t('watch.filter.example.collection'), text: "{ 'ns.coll': 'orders' }" }]
    : []),
])
</script>

<template>
  <div class="flex flex-col gap-3 border-b border-line px-4 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="sr-only">{{ t('watch.filter.chips') }}</span>
      <button
        v-for="op in shownOps"
        :key="op"
        type="button"
        :data-watch-chip="op"
        :aria-pressed="on(op)"
        :aria-label="t('watch.filter.chip', { op: words.op(op), n: feed.counts.value[op] ?? 0 })"
        class="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-small transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        :class="
          on(op)
            ? 'border-accent bg-accent-soft text-accent-fg'
            : 'border-line-strong text-fg-subtle line-through decoration-fg-subtle'
        "
        @click="toggle(op)"
      >
        {{ words.op(op) }}
        <span class="rounded-full bg-surface/70 px-1.5 tabular-nums">{{ feed.counts.value[op] ?? 0 }}</span>
      </button>
      <span class="ml-auto flex flex-wrap items-center gap-4">
        <DsCheckbox
          :model-value="feed.options.value.fullDocument"
          :label="t('watch.filter.fullDocument')"
          :hint="t('watch.filter.fullDocumentHint')"
          @update:model-value="(v: boolean) => apply({ fullDocument: v })"
        />
        <DsCheckbox
          :model-value="feed.options.value.schemaChanges"
          :label="t('watch.filter.schemaChanges')"
          :hint="t('watch.filter.schemaChangesHint')"
          @update:model-value="setSchema"
        />
        <!-- W4.7: record to a file (with the export right), and raise an alert on matches. -->
        <DsCheckbox
          v-if="canRecord"
          :model-value="feed.options.value.record"
          :label="t('watch.filter.record')"
          :hint="t('watch.filter.recordHint')"
          data-watch-record
          @update:model-value="(v: boolean) => apply({ record: v })"
        />
        <DsCheckbox
          :model-value="feed.options.value.alert"
          :label="t('watch.filter.alert')"
          :hint="t('watch.filter.alertHint')"
          data-watch-alert
          @update:model-value="(v: boolean) => apply({ alert: v })"
        />
        <DsButton
          size="sm"
          variant="ghost"
          data-watch-filter-toggle
          :aria-expanded="open"
          @click="emit('update:open', !open)"
        >
          {{ open ? t('watch.filter.hide') : t('watch.filter.show') }}
        </DsButton>
      </span>
    </div>
    <div v-if="open" data-watch-filter-editor class="flex flex-col gap-2">
      <DsCodeEditor
        v-model="text"
        multiline
        :rows="3"
        :label="t('watch.filter.editor')"
        :hint="t('watch.filter.hint')"
        :error="parseError ?? refused ?? undefined"
        placeholder="{ 'fullDocument.status': 'paid' }"
        @submit="applyText"
      />
      <div class="flex flex-wrap items-center gap-2 text-small">
        <span class="text-fg-subtle">{{ t('watch.filter.examples') }}:</span>
        <button
          v-for="ex in EXAMPLES"
          :key="ex.text"
          type="button"
          class="cursor-pointer rounded-md px-2 py-1 font-mono text-accent-fg hover:bg-accent-soft"
          :title="ex.label"
          @click="text = ex.text"
        >
          {{ ex.label }}
        </button>
        <span class="ml-auto flex gap-2">
          <DsButton
            v-if="Object.keys(feed.filter.value).length > 0"
            size="sm"
            variant="ghost"
            @click="((text = ''), apply({}, {}))"
          >
            {{ t('watch.filter.clear') }}
          </DsButton>
          <DsButton size="sm" variant="primary" data-watch-filter-apply @click="applyText">{{
            t('watch.filter.apply')
          }}</DsButton>
        </span>
      </div>
    </div>
  </div>
</template>
