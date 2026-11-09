<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MaskedBanner from '@/masking/MaskedBanner.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import {
  Activity,
  Download,
  Eraser,
  History,
  Pause,
  Play,
  RadioTower,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-vue-next'
import {
  deserializeValue,
  formatShell,
  serializeValue,
  type WatchEvent,
  type WatchRecordingPage,
  type WatchTarget,
} from '@mongo-manager/shared/browser'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsButton from '@/ds/DsButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import { downloadJson, downloadText } from '@/download'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { describeError } from '@/api/errors'
import { watchApi } from '@/api/watch'
import { useTabsStore } from '@/stores/tabs'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { defaultQuery, emptyDraft } from '@/documents/queryBuild'
import { openCollectionTab } from '@/workspace/openTabs'
import { acquireWatchFeed, releaseWatchFeed, type FeedEvent } from './feeds'
import WatchFilters from './WatchFilters.vue'
import WatchList from './WatchList.vue'
import WatchDetail from './WatchDetail.vue'
import WatchRecordings from './WatchRecordings.vue'
import { BEHIND_MS, useWatchWords } from './words'
import { docsPage } from '@/workspace/docs'

const props = defineProps<{
  target: WatchTarget
  canExport: boolean
  /** W4.7: the viewer may change the collection's options (databases:write): pre- and post-images. */
  canChangeOptions?: boolean
  /** Final review M5: a view's source collection, offered when the view cannot be watched. */
  viewOn?: string
}>()

// W5 (spec 3c §7): the masking hint on every data screen, and the hidden paths for the locks.
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db ?? ''),
  computed(() => props.target.coll ?? ''),
)
const { t, locale } = useI18n()
const words = useWatchWords()
const tabs = useTabsStore()
const views = useCollectionViewsStore()

const feed = acquireWatchFeed(props.target)
onBeforeUnmount(() => releaseWatchFeed(feed))

/**
 * W4.7: a collection without pre- and post-images shows updates without the document before. Who may
 * change its options turns them on here (a collMod), after saying what it costs.
 */
const dialogs = useDialogStore()
const toasts = useToastStore()
const imagesBusy = ref(false)
const offerImages = computed(
  () =>
    props.target.scope === 'collection' &&
    props.canChangeOptions === true &&
    feed.preImages.value === false &&
    !stopped.value,
)
async function turnOnImages(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('watch.preImages.confirmTitle'),
    message: t('watch.preImages.confirmMessage', { name: `${props.target.db}.${props.target.coll}` }),
    confirmLabel: t('watch.preImages.turnOn'),
  })
  if (!ok) return
  imagesBusy.value = true
  try {
    await watchApi.setPreImages(props.target.connectionId, props.target.db!, props.target.coll!, true)
    feed.preImages.value = true
    toasts.push({ kind: 'success', message: t('watch.preImages.on') })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    imagesBusy.value = false
  }
}

const filtersOpen = ref(false)
const selectedKey = ref<number | null>(null)
/**
 * W4.7: a recording replayed in place of the live feed (newest first, as the feed shows them).
 * W4 review I9: read a page at a time, on demand, and held shallowly (never made deeply reactive);
 * at most REPLAY_MAX events are shown — the download has the rest.
 */
const REPLAY_MAX = 5000
const recordingsOpen = ref(false)
const replay = shallowRef<{
  name: string
  fileId: string
  events: FeedEvent[]
  next: number
  end: boolean
} | null>(null)
const replayBusy = ref(false)
const asFeed = (events: WatchEvent[], already: number): FeedEvent[] =>
  events.map((e, i) => ({ ...e, key: -(already + i + 1) })).reverse()
function startReplay(r: { name: string; fileId: string; page: WatchRecordingPage }): void {
  replay.value = {
    name: r.name,
    fileId: r.fileId,
    events: asFeed(r.page.events.slice(0, REPLAY_MAX), 0),
    next: r.page.next,
    end: r.page.end,
  }
  selectedKey.value = null
  recordingsOpen.value = false
}
const replayCapped = computed(() => (replay.value?.events.length ?? 0) >= REPLAY_MAX)
async function moreReplay(): Promise<void> {
  const r = replay.value
  if (!r || r.end || replayCapped.value || replayBusy.value) return
  replayBusy.value = true
  try {
    const page = await watchApi.page(props.target.connectionId, r.fileId, r.next)
    if (replay.value?.fileId !== r.fileId) return
    const room = REPLAY_MAX - r.events.length
    replay.value = {
      ...r,
      events: [...asFeed(page.events.slice(0, room), r.events.length), ...r.events],
      next: page.next,
      end: page.end,
    }
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    replayBusy.value = false
  }
}
function endReplay(): void {
  replay.value = null
  selectedKey.value = null
}
const shownEvents = computed(() => replay.value?.events ?? feed.events.value)
const selected = computed(() => shownEvents.value.find((e) => e.key === selectedKey.value) ?? null)
const status = feed.status
const running = computed(() => ['starting', 'live', 'paused', 'reconnecting'].includes(status.value))
const stopped = computed(() => ['ended', 'refused', 'unavailable'].includes(status.value))
/** The state pill's dot: its own colour (never inherited), pulsing only while live. */
const dotClass = computed(() => {
  if (status.value === 'live' && feed.lagMs.value < BEHIND_MS) return 'bg-success motion-safe:animate-pulse'
  if (['paused', 'reconnecting', 'live'].includes(status.value)) return 'bg-warning'
  return 'bg-fg-subtle'
})
/** A refused filter is said at the editor; elsewhere the feed only asks for it to be fixed. */
const filterRefused = computed(
  () =>
    status.value === 'refused' && ['filter', 'masking_filter', 'internal'].includes(feed.reason.value ?? ''),
)
const stoppedText = computed(() => (filterRefused.value ? t('watch.fixFilter') : words.reason(feed)))
/** "Start again" only where it can help: not with the same refused filter, nor with watching off. */
/** Where watching cannot work (no replica set, a view, turned off, no real-time socket): nothing to retry or set. */
const deadEnd = computed(
  () =>
    status.value === 'unavailable' ||
    (status.value === 'refused' &&
      ['not_replica_set', 'view', 'turned_off'].includes(feed.reason.value ?? '')),
)
const canRestart = computed(
  () => !deadEnd.value && feed.reason.value !== 'turned_off' && !filterRefused.value,
)

function togglePause(): void {
  if (status.value === 'live') feed.pause()
  else if (status.value === 'paused') feed.resume('here')
}

// Spec §4.2: new events are announced politely and in batches, never one by one.
const announcement = ref('')
let announced = feed.total.value
const announcer = setInterval(() => {
  const added = feed.total.value - announced
  announced = feed.total.value
  if (added > 0) announcement.value = t('watch.announce', added)
}, 2_000)
onBeforeUnmount(() => clearInterval(announcer))
watch(feed.total, (n) => {
  if (n < announced) announced = n
})

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const scopeName = computed(() =>
  props.target.scope === 'collection'
    ? `${props.target.db}.${props.target.coll}`
    : props.target.scope === 'database'
      ? props.target.db!
      : 'deployment',
)
const plainEvents = () => [...feed.events.value].reverse().map(({ key: _key, ...e }) => e)
function exportAs(kind: string): void {
  const name = `watch-${scopeName.value}-${stamp()}`
  if (kind === 'json') downloadJson(plainEvents(), `${name}.json`)
  else
    downloadText(
      plainEvents()
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
      `${name}.ndjson`,
    )
}

/** "Open document": the collection's Documents section, filtered by the event's _id. */
/** Final review M5: where watching cannot work, the guide says why and what to do. */
const docsHref = computed(() => docsPage(locale.value, 'watch.html#requirements'))
const showGuide = computed(
  () =>
    status.value === 'refused' && ['not_replica_set', 'view', 'turned_off'].includes(feed.reason.value ?? ''),
)

/** A view cannot be watched: watch the collection it reads, in its own tab. */
function watchSource(): void {
  if (!props.viewOn || !props.target.db) return
  const tabId = openCollectionTab(tabs, props.target.connectionId, props.target.db, props.viewOn)
  views.stateFor(tabId).section = 'watch'
}

function open(e: FeedEvent): void {
  const id = (e.documentKey as { _id?: unknown } | undefined)?._id
  if (id === undefined || !e.ns.coll) return
  const tabId = openCollectionTab(tabs, props.target.connectionId, e.ns.db, e.ns.coll)
  const state = views.stateFor(tabId)
  state.section = 'documents'
  state.draft = { ...emptyDraft(), filter: formatShell(deserializeValue({ _id: id }), { indent: 0 }) }
  state.query = {
    ...defaultQuery(),
    filter: serializeValue(deserializeValue({ _id: id })) as Record<string, unknown>,
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" :aria-label="t('documents.sections.watch')">
    <div
      role="toolbar"
      tabindex="0"
      :aria-label="t('watch.toolbar')"
      class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none focus-visible:ring-inset"
      @keydown.space.self.prevent="togglePause"
    >
      <span
        data-watch-status
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-small font-medium"
        :class="{
          'bg-success-soft text-success': status === 'live' && feed.lagMs.value < BEHIND_MS,
          'bg-warning-soft text-warning':
            status === 'paused' ||
            status === 'reconnecting' ||
            (status === 'live' && feed.lagMs.value >= BEHIND_MS),
          'bg-muted text-fg-muted': !['live', 'paused', 'reconnecting'].includes(status),
        }"
      >
        <span aria-hidden="true" class="size-2 rounded-full" :class="dotClass" />
        {{ words.status(feed) }}
      </span>
      <span
        v-if="feed.recording.value && running"
        class="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-1 text-small font-medium text-danger"
        data-watch-recording
      >
        <span aria-hidden="true" class="size-2 rounded-full bg-danger" />{{ t('watch.recordings.on') }}
      </span>
      <span class="text-small text-fg-subtle tabular-nums">
        {{ t('watch.count', feed.total.value) }}
        <template v-if="status === 'live'">
          · {{ t('watch.rate', { n: feed.rate.value.toFixed(1) }) }}</template
        >
      </span>
      <span class="ml-auto flex flex-wrap items-center gap-2">
        <DsButton
          v-if="status === 'live'"
          size="sm"
          variant="secondary"
          data-watch-pause
          @click="feed.pause()"
        >
          <Pause class="size-4" aria-hidden="true" />
          {{ t('watch.pause') }}
        </DsButton>
        <template v-else-if="status === 'paused'">
          <DsButton
            size="sm"
            variant="primary"
            data-watch-catch-up
            :title="t('watch.catchUpHint')"
            @click="feed.resume('here')"
          >
            <Play class="size-4" aria-hidden="true" />
            {{ t('watch.catchUp') }}
          </DsButton>
          <DsButton
            size="sm"
            variant="secondary"
            data-watch-from-now
            :title="t('watch.fromNowHint')"
            @click="feed.resume('now')"
          >
            <SkipForward class="size-4" aria-hidden="true" />
            {{ t('watch.fromNow') }}
          </DsButton>
        </template>
        <DsButton size="sm" variant="ghost" :disabled="feed.total.value === 0" @click="feed.clear()">
          <Eraser class="size-4" aria-hidden="true" />
          {{ t('watch.clear') }}
        </DsButton>
        <DsButton
          v-if="canExport"
          size="sm"
          variant="ghost"
          data-watch-recordings-toggle
          :aria-expanded="recordingsOpen"
          @click="recordingsOpen = !recordingsOpen"
        >
          <History class="size-4" aria-hidden="true" />
          {{ t('watch.recordings.title') }}
        </DsButton>
        <span v-if="canExport && feed.events.value.length > 0" data-watch-export>
          <DsMenu
            focusable
            text
            :icon="Download"
            :label="t('watch.export')"
            :items="[
              { id: 'ndjson', label: t('watch.exportNdjson'), icon: Download },
              { id: 'json', label: t('watch.exportJson'), icon: Download },
            ]"
            @select="exportAs"
          />
        </span>
      </span>
    </div>
    <!-- W4.7: the recorded feeds, and a replay shown in place of the live feed. -->
    <WatchRecordings
      v-if="recordingsOpen && canExport"
      :connection-id="target.connectionId"
      @replay="startReplay"
    />
    <p
      v-if="replay"
      role="status"
      class="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-2 text-ui text-fg"
      data-watch-replay
    >
      <History class="size-4" aria-hidden="true" />{{
        t('watch.recordings.replaying', { name: replay.name, n: replay.events.length })
      }}
      <span v-if="replayCapped" class="text-small text-fg-muted">{{
        t('watch.recordings.capped', { n: REPLAY_MAX })
      }}</span>
      <DsButton
        v-if="!replay.end && !replayCapped"
        size="sm"
        variant="secondary"
        class="ml-auto"
        :loading="replayBusy"
        data-replay-more
        @click="moreReplay"
        >{{ t('watch.recordings.more') }}</DsButton
      >
      <DsButton
        size="sm"
        variant="secondary"
        :class="replay.end || replayCapped ? 'ml-auto' : ''"
        data-replay-back
        @click="endReplay"
        >{{ t('watch.recordings.backToLive') }}</DsButton
      >
    </p>
    <p
      v-if="feed.notice.value"
      role="status"
      class="flex items-center gap-2 border-b border-line bg-info-soft px-4 py-2 text-ui text-fg"
    >
      {{ t(`watch.notice.${feed.notice.value}`) }}
      <button
        type="button"
        class="ml-auto cursor-pointer rounded p-1 text-fg-muted hover:bg-subtle hover:text-fg"
        :aria-label="t('watch.dismiss')"
        @click="feed.notice.value = null"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </p>
    <p
      v-if="offerImages"
      class="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-4 py-2 text-ui text-fg-muted"
      data-watch-pre-images
    >
      {{ t('watch.preImages.offer') }}
      <DsButton size="sm" variant="secondary" class="ml-auto" :loading="imagesBusy" @click="turnOnImages">{{
        t('watch.preImages.turnOn')
      }}</DsButton>
    </p>
    <MaskedBanner
      v-if="masking.hidden.value"
      :wide="target.scope !== 'collection'"
      class="border-b border-line px-4 py-2"
    />
    <WatchFilters
      v-if="!deadEnd && !replay"
      v-model:open="filtersOpen"
      :feed="feed"
      :scope="target.scope"
      :can-record="canExport"
    />
    <DsEmptyState
      v-if="!replay && stopped && feed.events.value.length === 0"
      class="m-auto"
      :icon="RadioTower"
      :title="t('watch.stoppedTitle')"
      :description="stoppedText"
    >
      <template #actions>
        <DsButton v-if="canRestart" size="sm" variant="primary" data-watch-start-again @click="feed.start()">
          <RotateCcw class="size-4" aria-hidden="true" />
          {{ t('watch.startAgain') }}
        </DsButton>
        <DsButton
          v-if="feed.reason.value === 'view' && viewOn"
          size="sm"
          variant="primary"
          data-watch-view-source
          @click="watchSource"
        >
          {{ t('watch.watchSource', { coll: viewOn }) }}
        </DsButton>
        <a
          v-if="showGuide"
          :href="docsHref"
          target="_blank"
          rel="noopener"
          class="text-ui text-accent-fg hover:underline"
        >
          {{ t('watch.learnMore') }}
        </a>
      </template>
    </DsEmptyState>
    <div
      v-else
      class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1"
    >
      <div class="flex min-h-0 flex-col border-line lg:border-r">
        <p
          v-if="stopped && !replay"
          role="alert"
          class="flex items-center gap-3 border-b border-line px-4 py-2 text-ui"
        >
          {{ stoppedText }}
          <DsButton
            v-if="canRestart"
            size="sm"
            variant="secondary"
            data-watch-start-again
            class="ml-auto"
            @click="feed.start()"
          >
            <RotateCcw class="size-4" aria-hidden="true" />
            {{ t('watch.startAgain') }}
          </DsButton>
        </p>
        <DsEmptyState
          v-if="!replay && running && feed.events.value.length === 0"
          class="m-auto"
          :icon="Activity"
          :title="t('watch.empty.title')"
          :description="
            feed.exists.value === false
              ? t('watch.empty.missing')
              : t('watch.empty.body', { where: t(`watch.where.${target.scope}`) })
          "
        />
        <WatchList
          v-else
          :events="shownEvents"
          :scope="target.scope"
          :selected="selectedKey"
          @select="selectedKey = $event"
        />
        <p v-if="feed.dropped.value > 0" class="border-t border-line px-4 py-1 text-small text-fg-subtle">
          {{ t('watch.kept', { n: feed.events.value.length }) }}
        </p>
      </div>
      <WatchDetail :event="selected" :target="target" :pre-images="feed.preImages.value" @open="open" />
    </div>
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>
  </section>
</template>
