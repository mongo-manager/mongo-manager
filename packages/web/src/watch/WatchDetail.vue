<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, ExternalLink } from 'lucide-vue-next'
import {
  deserializeValue,
  documentDiff,
  formatShell,
  type FieldChange,
  type WatchTarget,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCodeView from '@/ds/DsCodeView.vue'
import DiffList from '@/documents/DiffList.vue'
import TreeNode from '@/documents/TreeNode.vue'
import { formatBytes } from '@/format'
import { idLabel } from '@/documents/values'
import OpBadge from './OpBadge.vue'
import type { FeedEvent } from './feeds'
import { eventTime } from './words'
import { docsPage } from '@/workspace/docs'

const props = defineProps<{ event: FeedEvent | null; target: WatchTarget; preImages: boolean | null }>()
const emit = defineEmits<{ open: [event: FeedEvent] }>()
const { t, locale } = useI18n()
const view = ref<'changes' | 'json'>('changes')
const copied = ref(false)

const plain = (v: unknown) => (v === undefined ? undefined : deserializeValue<Record<string, unknown>>(v))
const after = computed(() => plain(props.event?.fullDocument))
const before = computed(() => plain(props.event?.before))
/** With both images, the exact change; without, what MongoDB reported. */
/** A value at a dotted path of a (deserialised) document; array positions are numbers. */
function at(doc: unknown, path: string): { found: boolean; value?: unknown } {
  let here: unknown = doc
  for (const segment of path.split('.')) {
    if (here === null || typeof here !== 'object' || !Object.hasOwn(here, segment)) return { found: false }
    here = (here as Record<string, unknown>)[segment]
  }
  return { found: true, value: here }
}
/**
 * The exact change: from both images, or — with a before-image only (pre-images on, no "whole
 * document after updates") — from the before-image and MongoDB's update description.
 */
const diff = computed<FieldChange[] | null>(() => {
  if (!before.value) return null
  if (after.value) {
    const d = documentDiff(before.value, after.value)
    return d.kind === 'none' ? [] : d.changes
  }
  const update = props.event?.update
  if (!update) return null
  const changes: FieldChange[] = []
  for (const [path, value] of Object.entries(update.updated)) {
    const old = at(before.value, path)
    changes.push(
      old.found
        ? { path, before: old.value, after: deserializeValue(value) }
        : { path, after: deserializeValue(value) },
    )
  }
  for (const path of update.removed) {
    const old = at(before.value, path)
    if (old.found) changes.push({ path, before: old.value })
  }
  return changes
})
const updated = computed(() =>
  Object.entries(props.event?.update?.updated ?? {}).map(([path, value]) => ({
    path,
    value: deserializeValue(value),
  })),
)
/** Final review C1/I6: the parts left out for their size, named beside the event by the server. */
const ELIDED_WORDS = {
  fullDocument: 'watch.detail.elided',
  before: 'watch.detail.elidedBefore',
  update: 'watch.detail.elidedUpdate',
  documentKey: 'watch.detail.elidedKey',
  description: 'watch.detail.elidedDescription',
} as const
const elidedNotes = computed(() =>
  Object.entries(props.event?.elided ?? {}).map(([part, bytes]) =>
    t(ELIDED_WORDS[part as keyof typeof ELIDED_WORDS] ?? 'watch.detail.elided', {
      size: formatBytes(bytes, locale.value),
    }),
  ),
)
const nsLabel = computed(() =>
  props.event
    ? props.event.ns.coll
      ? `${props.event.ns.db}.${props.event.ns.coll}`
      : props.event.ns.db
    : '',
)
const key = computed(() => (props.event?.documentKey as { _id?: unknown } | undefined)?._id)
/** "Open document" needs a key with nothing hidden in it (final review M9), and a collection. */
const canOpen = computed(
  () =>
    key.value !== undefined && !JSON.stringify(key.value).includes('"***"') && Boolean(props.event?.ns.coll),
)
/** Final review M9: a delete without a before-image carries no document; say why. */
const deletedWithoutDocument = computed(
  () =>
    props.event?.op === 'delete' &&
    props.event.before === undefined &&
    props.event.elided?.before === undefined,
)
/** Final review M9: copying is offered only where the browser can copy, and says so only once it did. */
const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
const VIEWS = ['changes', 'json'] as const
const ids = useId()
const tabId = (v: (typeof VIEWS)[number]) => `${ids}-${v}`
const panelId = `${ids}-panel`
function onTabKey(event: KeyboardEvent): void {
  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -9, End: 9 }
  const step = moves[event.key]
  if (step === undefined) return
  event.preventDefault()
  const index = Math.min(1, Math.max(0, VIEWS.indexOf(view.value) + step))
  view.value = VIEWS[index]!
  void nextTick(() => document.getElementById(tabId(view.value))?.focus())
}
const docsHref = computed(() => docsPage(locale.value, 'watch.html#pre-images'))
const json = computed(() => {
  if (!props.event) return ''
  const { key: _ordinal, ...rest } = props.event
  return JSON.stringify(rest, null, 2)
})
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(json.value)
  } catch {
    return
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
const exact = (e: FeedEvent) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'medium' }).format(eventTime(e))
</script>

<template>
  <section
    data-watch-detail
    :aria-label="t('watch.detail.label')"
    class="flex min-h-0 flex-col overflow-auto p-4"
  >
    <p v-if="!event" class="m-auto text-ui text-fg-subtle">{{ t('watch.detail.none') }}</p>
    <template v-else>
      <header class="flex flex-wrap items-center gap-2">
        <OpBadge :op="event.op" />
        <span class="font-mono text-small text-fg-muted">{{ nsLabel }}</span>
        <span v-if="key !== undefined" class="truncate font-mono text-small font-medium">{{
          idLabel(deserializeValue(key))
        }}</span>
        <time class="text-small text-fg-subtle" :datetime="new Date(eventTime(event)).toISOString()">{{
          exact(event)
        }}</time>
        <span class="ml-auto flex gap-2">
          <DsButton v-if="canOpen" size="sm" variant="secondary" data-watch-open @click="emit('open', event)">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ t('watch.detail.open') }}
          </DsButton>
          <DsButton v-if="canCopy" size="sm" variant="ghost" data-watch-copy @click="copy">
            <Copy class="size-4" aria-hidden="true" />
            {{ copied ? t('watch.detail.copied') : t('watch.detail.copy') }}
          </DsButton>
        </span>
      </header>
      <p v-if="event.masked" class="mt-3 rounded-md bg-subtle px-3 py-2 text-small text-fg-muted">
        {{ t('watch.detail.masked') }}
      </p>
      <div
        role="tablist"
        :aria-label="t('watch.detail.label')"
        class="mt-4 flex gap-1 border-b border-line"
        @keydown="onTabKey"
      >
        <button
          v-for="v in VIEWS"
          :id="tabId(v)"
          :key="v"
          type="button"
          role="tab"
          :aria-selected="view === v"
          :aria-controls="panelId"
          :tabindex="view === v ? 0 : -1"
          class="cursor-pointer border-b-2 px-3 py-1.5 text-ui transition-colors"
          :class="
            view === v
              ? 'border-accent font-medium text-accent-fg'
              : 'border-transparent text-fg-subtle hover:text-fg'
          "
          @click="view = v"
        >
          {{
            v === 'changes'
              ? event.update
                ? t('watch.detail.changes')
                : t('watch.detail.document')
              : t('watch.detail.json')
          }}
        </button>
      </div>
      <div
        v-if="view === 'json'"
        :id="panelId"
        role="tabpanel"
        :aria-labelledby="tabId('json')"
        class="mt-3 min-h-0"
      >
        <DsCodeView :text="json" />
      </div>
      <div
        v-else
        :id="panelId"
        role="tabpanel"
        :aria-labelledby="tabId('changes')"
        class="mt-3 flex flex-col gap-4 text-ui"
      >
        <p
          v-for="note in elidedNotes"
          :key="note"
          class="rounded-md bg-warning-soft px-3 py-2 text-small text-warning"
        >
          {{ note }}
        </p>
        <template v-if="event.update">
          <DiffList v-if="diff" :changes="diff" />
          <template v-else>
            <div v-if="updated.length > 0">
              <h4 class="mb-1 text-small font-semibold text-fg-subtle uppercase">
                {{ t('watch.detail.updated') }}
              </h4>
              <dl class="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-small">
                <template v-for="u in updated" :key="u.path">
                  <dt class="truncate text-fg-muted">{{ u.path }}</dt>
                  <dd class="truncate">{{ formatShell(u.value, { indent: 0 }) }}</dd>
                </template>
              </dl>
            </div>
            <div v-if="event.update.removed.length > 0">
              <h4 class="mb-1 text-small font-semibold text-fg-subtle uppercase">
                {{ t('watch.detail.removed') }}
              </h4>
              <p class="font-mono text-small">{{ event.update.removed.join(', ') }}</p>
            </div>
            <p v-if="target.scope === 'collection' && preImages === false" class="text-small text-fg-subtle">
              {{ t('watch.detail.noPreImages') }}
              <a :href="docsHref" target="_blank" rel="noopener" class="text-accent-fg hover:underline">{{
                t('watch.detail.learnHow')
              }}</a>
            </p>
          </template>
          <div v-if="event.update.truncated.length > 0">
            <h4 class="mb-1 text-small font-semibold text-fg-subtle uppercase">
              {{ t('watch.detail.truncated') }}
            </h4>
            <p v-for="a in event.update.truncated" :key="a.field" class="text-small">
              {{ t('watch.detail.truncatedTo', { field: a.field, n: a.newSize }) }}
            </p>
          </div>
        </template>
        <p v-else-if="deletedWithoutDocument" class="text-small text-fg-subtle">
          {{ t('watch.detail.deletedNoDocument') }}
        </p>
        <ul v-else-if="after ?? before" class="font-mono text-small">
          <TreeNode
            v-for="(value, name) in after ?? before"
            :key="name"
            :name="String(name)"
            :value="value"
            :depth="0"
          />
        </ul>
        <div v-if="event.description !== undefined">
          <h4 class="mb-1 text-small font-semibold text-fg-subtle uppercase">
            {{ t('watch.detail.description') }}
          </h4>
          <DsCodeView :text="JSON.stringify(event.description, null, 2)" />
        </div>
      </div>
    </template>
  </section>
</template>
