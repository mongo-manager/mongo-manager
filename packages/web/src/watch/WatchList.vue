<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { deserializeValue, type WatchScope } from '@mongo-manager/shared/browser'
import { idLabel } from '@/documents/values'
import { useVirtualRows } from '@/documents/useVirtualRows'
import { EyeOff } from 'lucide-vue-next'
import OpBadge from './OpBadge.vue'
import type { FeedEvent } from './feeds'
import { eventTime, useWatchWords } from './words'

const props = defineProps<{ events: FeedEvent[]; scope: WatchScope; selected: number | null }>()
const emit = defineEmits<{ select: [key: number] }>()
const { t, locale } = useI18n()
const words = useWatchWords()

const ROW = 44
const container = ref<HTMLElement | null>(null)
const range = useVirtualRows(
  container,
  computed(() => props.events.length),
  ref(ROW),
)
const shown = computed(() => props.events.slice(range.value.start, range.value.end))
const pending = ref(0)
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 5_000)
onBeforeUnmount(() => clearInterval(clock))

/**
 * New events arrive at the top. While the reader is scrolled down, what they read stays where it
 * is and the new rows wait behind a pill (spec §4.2).
 */
watch(
  () => props.events[0]?.key,
  (top, previous) => {
    const el = container.value
    if (top === undefined || previous === undefined || !el || el.scrollTop <= 0) return
    const added = top - previous
    if (added <= 0) return
    pending.value += added
    el.scrollTop += added * ROW
  },
  { flush: 'post' },
)
const onScroll = () => {
  if ((container.value?.scrollTop ?? 0) <= 0) pending.value = 0
}
function toTop(): void {
  container.value?.scrollTo({ top: 0 })
  pending.value = 0
}

const keyOf = (e: FeedEvent) => {
  const id = (e.documentKey as { _id?: unknown } | undefined)?._id
  return id === undefined ? t('watch.list.noKey') : idLabel(deserializeValue(id))
}
function summary(e: FeedEvent): string {
  if (!e.update) return e.to ? `→ ${e.to.db}.${e.to.coll}` : ''
  const fields = Object.keys(e.update.updated)
  const head = fields.slice(0, 3).join(', ')
  const more = fields.length > 3 ? ` ${t('watch.list.more', { n: fields.length - 3 })}` : ''
  const removed =
    e.update.removed.length > 0
      ? ` · ${t('watch.list.removed', { fields: e.update.removed.join(', ') })}`
      : ''
  return `${head}${more}${removed}`
}
const exact = (e: FeedEvent) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'medium' }).format(eventTime(e))
const label = (e: FeedEvent) =>
  [
    t('watch.list.row', { op: words.op(e.op), key: keyOf(e), time: words.when(eventTime(e), now.value) }),
    props.scope !== 'collection'
      ? t('watch.list.in', { ns: `${e.ns.db}${e.ns.coll ? `.${e.ns.coll}` : ''}` })
      : '',
    e.masked ? t('watch.list.hidden') : '',
  ]
    .filter(Boolean)
    .join(', ')
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <button
      v-if="pending > 0"
      type="button"
      data-watch-new
      class="absolute top-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full bg-accent px-3 py-1 text-small font-medium text-on-accent shadow-md transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:outline-none"
      @click="toTop"
    >
      {{ t('watch.newEvents', pending) }}
    </button>
    <div ref="container" class="h-full overflow-auto" @scroll.passive="onScroll">
      <ul
        :aria-label="t('watch.list.label')"
        class="relative"
        :style="{ paddingTop: `${range.padTop}px`, paddingBottom: `${range.padBottom}px` }"
      >
        <li v-for="e in shown" :key="e.key" :style="{ height: `${ROW}px` }">
          <button
            type="button"
            data-watch-row
            :aria-label="label(e)"
            :aria-current="selected === e.key ? 'true' : undefined"
            class="flex h-full w-full cursor-pointer items-center gap-3 border-b border-line px-3 text-left text-ui transition-colors hover:bg-subtle focus-visible:bg-accent-soft focus-visible:outline-none"
            :class="selected === e.key ? 'bg-accent-soft' : ''"
            @click="emit('select', e.key)"
          >
            <OpBadge :op="e.op" />
            <span v-if="scope !== 'collection'" class="shrink-0 truncate font-mono text-small text-fg-subtle">
              {{ e.ns.coll ? (scope === 'deployment' ? `${e.ns.db}.${e.ns.coll}` : e.ns.coll) : e.ns.db }}
            </span>
            <span
              data-watch-key
              :title="keyOf(e)"
              class="max-w-[14rem] shrink-0 truncate font-mono text-small text-fg"
              >{{ keyOf(e) }}</span
            >
            <span class="min-w-0 flex-1 truncate text-small text-fg-subtle">{{ summary(e) }}</span>
            <EyeOff v-if="e.masked" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <time
              class="shrink-0 text-small text-fg-subtle tabular-nums"
              :datetime="new Date(eventTime(e)).toISOString()"
              :title="exact(e)"
            >
              {{ words.when(eventTime(e), now) }}
            </time>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
