<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { SavedPipelineView } from '@mongo-manager/shared/browser'
import { aggregateApi, aggregateKeys } from '@/api/aggregate'
import type { CollectionTarget } from '@/api/documents'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useSessionStore } from '@/stores/session'
import SaveItemDialog from '@/library/SaveItemDialog.vue'
import { saveError } from '@/library/errors'

/** Phase 2a spec §4.6: the collection's saved pipelines, to open, share or delete. */
const props = defineProps<{ target: CollectionTarget }>()
const emit = defineEmits<{
  open: [pipeline: SavedPipelineView]
  removed: [id: string]
  /** Reviewer C I3: renamed, re-tagged or shared here — the builder saves with the new values. */
  updated: [pipeline: SavedPipelineView]
}>()
// UI redesign R1 review: sharing is for other users — none in local mode, so it is not offered there.
const session = useSessionStore()
const canShare = computed(() => session.status?.mode === 'team')
const { t } = useI18n()
const id = useId()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
/** Seventh review of the floating window (M-3): closed by Escape, focus back on its button. */
function closeList(): void {
  open.value = false
  trigger.value?.focus()
}
const search = ref('')
/** Phase 2c: shows only the pipelines with this tag. */
const tag = ref<string | null>(null)

const key = computed(() => aggregateKeys.pipelines(props.target))
const { data, error, isPending } = useQuery({
  queryKey: key,
  queryFn: () => aggregateApi.pipelines.list(props.target),
  enabled: open,
})
// The search matches tags too, with or without # (final review 2c, Minor 18).
const shown = computed(() => {
  const q = search.value.trim().toLowerCase().replace(/^#+/, '')
  return (data.value?.pipelines ?? []).filter(
    (p) =>
      (!q || p.name.toLowerCase().includes(q) || p.tags.some((x) => x.includes(q))) &&
      (!tag.value || p.tags.includes(tag.value)),
  )
})
const allTags = computed(() => [...new Set((data.value?.pipelines ?? []).flatMap((p) => p.tags))].sort())
// A chosen tag whose last pipeline went is let go, or the list would stay empty with no chip to clear.
watch(allTags, (list) => {
  if (tag.value && !list.includes(tag.value)) tag.value = null
})
const refresh = () => queryClient.invalidateQueries({ queryKey: key.value })

function choose(pipeline: SavedPipelineView): void {
  open.value = false
  emit('open', pipeline)
}

async function share(pipeline: SavedPipelineView): Promise<void> {
  try {
    emit(
      'updated',
      await aggregateApi.pipelines.update(props.target, pipeline.id, {
        name: pipeline.name,
        stages: pipeline.stages,
        tags: pipeline.tags,
        shared: !pipeline.shared,
      }),
    )
    toasts.push({
      kind: 'success',
      message: pipeline.shared
        ? t('aggregation.saved.unsharedNow', { name: pipeline.name })
        : t('aggregation.saved.sharedNow', { name: pipeline.name }),
    })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

async function remove(pipeline: SavedPipelineView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('aggregation.saved.deleteTitle'),
    message: t('aggregation.saved.deleteMessage', { name: pipeline.name }),
    confirmLabel: t('aggregation.saved.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await aggregateApi.pipelines.remove(props.target, pipeline.id)
    emit('removed', pipeline.id)
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

const updated = (iso: string) => new Date(iso).toLocaleString()

// ---- Rename, re-tag and share in one dialog (final review 2c, I2)
const editing = ref<SavedPipelineView | null>(null)
const editBusy = ref(false)
const editError = ref('')
function edit(pipeline: SavedPipelineView): void {
  editError.value = ''
  editing.value = pipeline
}
async function onEdit(change: { name: string; tags: string[]; shared: boolean }): Promise<void> {
  const pipeline = editing.value
  if (!pipeline || editBusy.value) return
  editBusy.value = true
  try {
    emit(
      'updated',
      await aggregateApi.pipelines.update(props.target, pipeline.id, {
        name: change.name,
        stages: pipeline.stages,
        tags: change.tags,
        shared: change.shared,
      }),
    )
    editing.value = null
    await refresh()
  } catch (e) {
    editError.value = saveError(e, t)
  } finally {
    editBusy.value = false
  }
}
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      type="button"
      class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
      :class="open ? 'bg-subtle text-fg' : ''"
      :aria-expanded="open"
      :aria-controls="open ? `${id}-list` : undefined"
      @click="open = !open"
    >
      {{ t('aggregation.saved.menu') }}
    </button>
    <div
      v-if="open"
      :id="`${id}-list`"
      data-ds-popup
      class="absolute top-full right-0 z-30 mt-1 w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl bg-raised p-1.5 shadow-float ring-1 ring-line animate-pop"
      @keydown.escape.stop.prevent="closeList()"
    >
      <input
        v-model="search"
        type="search"
        :aria-label="t('aggregation.saved.search')"
        :placeholder="t('aggregation.saved.search')"
        class="mb-1.5 h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-ui text-fg placeholder:text-fg-subtle focus:border-focus focus:ring-3 focus:ring-focus/20 focus-visible:outline-none"
      />
      <div v-if="allTags.length" class="mb-2 flex flex-wrap gap-1">
        <button
          v-for="t2 in allTags"
          :key="t2"
          type="button"
          :data-tag="t2"
          :aria-pressed="tag === t2"
          class="cursor-pointer rounded px-1.5 py-0.5 text-small"
          :class="tag === t2 ? 'bg-accent text-on-accent' : 'bg-muted text-fg'"
          @click="tag = tag === t2 ? null : t2"
        >
          #{{ t2 }}
        </button>
      </div>
      <p v-if="isPending" class="px-2 py-1 text-ui text-fg-subtle">{{ t('aggregation.loading') }}</p>
      <p v-else-if="error" role="alert" class="px-2 py-1 text-ui text-danger">
        {{ describeError(error, t) }}
      </p>
      <p v-else-if="shown.length === 0" class="px-2 py-1 text-ui text-fg-subtle">
        {{ t('aggregation.saved.none') }}
      </p>
      <ul class="max-h-80 overflow-auto">
        <li
          v-for="pipeline in shown"
          :key="pipeline.id"
          :data-pipeline="pipeline.id"
          class="flex flex-col gap-1.5 rounded-lg px-2.5 py-2 hover:bg-subtle"
        >
          <span class="min-w-0">
            <span class="block truncate text-ui font-medium text-fg">{{ pipeline.name }}</span>
            <span class="block text-small text-fg-subtle">
              <span v-if="pipeline.shared" class="mr-1 rounded bg-accent-soft px-1 text-accent-fg">{{
                t('aggregation.saved.shared')
              }}</span>
              <span v-if="!pipeline.mine && pipeline.owner" class="mr-1">{{
                t('aggregation.saved.by', { owner: pipeline.owner })
              }}</span>
              <span>{{ updated(pipeline.updatedAt) }}</span>
              <span v-for="t2 in pipeline.tags" :key="t2" class="ml-1 rounded bg-muted px-1">#{{ t2 }}</span>
            </span>
          </span>
          <span class="flex flex-wrap items-center gap-1">
            <button
              type="button"
              data-action="open"
              class="inline-flex h-7 cursor-pointer items-center rounded-md bg-accent px-2.5 text-small font-medium text-on-accent hover:bg-accent-hover"
              @click="choose(pipeline)"
            >
              {{ t('aggregation.saved.open') }}
            </button>
            <button
              v-if="pipeline.mine"
              type="button"
              data-action="edit"
              class="inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-small text-fg-muted hover:bg-muted hover:text-fg"
              :aria-label="t('library.editNamed', { name: pipeline.name })"
              @click="edit(pipeline)"
            >
              {{ t('library.edit') }}
            </button>
            <button
              v-if="pipeline.mine && canShare"
              type="button"
              data-action="share"
              :title="pipeline.shared ? t('aggregation.saved.unshareHint') : t('aggregation.saved.shareHint')"
              class="inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-small text-fg-muted hover:bg-muted hover:text-fg"
              @click="share(pipeline)"
            >
              {{ pipeline.shared ? t('aggregation.saved.unshare') : t('aggregation.saved.share') }}
            </button>
            <button
              v-if="pipeline.mine"
              type="button"
              data-action="delete"
              class="ml-auto inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-small text-danger hover:bg-danger-soft"
              @click="remove(pipeline)"
            >
              {{ t('aggregation.saved.delete') }}
            </button>
          </span>
        </li>
      </ul>
    </div>
    <SaveItemDialog
      v-if="editing"
      :title="t('library.editPipeline')"
      :name="editing.name"
      :tags="editing.tags"
      :shared="editing.shared"
      :busy="editBusy"
      :error="editError"
      @save="onEdit"
      @close="editing = null"
    />
  </div>
</template>
