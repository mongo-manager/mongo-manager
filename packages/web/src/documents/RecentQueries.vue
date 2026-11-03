<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { History } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { describeError } from '@/api/errors'
import { documentsApi, type CollectionTarget, type RecentQuery } from '@/api/documents'
import { favouritesApi } from '@/api/library'
import type { FavouriteView } from '@mongo-manager/shared/browser'
import { useDialogStore } from '@/stores/dialogs'
import { decodeValue, toShell } from './values'

const props = defineProps<{ target: CollectionTarget }>()
const emit = defineEmits<{ pick: [query: RecentQuery] }>()
const { t } = useI18n()
const dialogs = useDialogStore()

const open = ref(false)
const loading = ref(false)
const error = ref('')
const items = ref<RecentQuery[]>([])
const favourites = ref<FavouriteView[]>([])
/** The favourites failed on their own: the recent queries still show (final review 2c, Minor 19). */
const favouritesFailed = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const listId = useId()

/** One line per query: the filter, then any other parts by name. */
function describe(q: RecentQuery): string {
  const shell = (v: unknown) => toShell(decodeValue(v), 0)
  const parts = [shell(q.filter)]
  if (q.projection) parts.push(`projection: ${shell(q.projection)}`)
  if (q.sort) parts.push(`sort: ${shell(q.sort)}`)
  if (q.collation) parts.push(`collation: ${shell(q.collation)}`)
  if (q.hint !== undefined) parts.push(`hint: ${typeof q.hint === 'string' ? q.hint : shell(q.hint)}`)
  return parts.join(' ')
}

const triggerEl = () => trigger.value

function onOutside(event: Event): void {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !triggerEl()?.contains(target)) close(false)
}

async function show(): Promise<void> {
  open.value = true
  loading.value = true
  error.value = ''
  favouritesFailed.value = false
  document.addEventListener('pointerdown', onOutside, true)
  try {
    const [recent, saved] = await Promise.all([
      documentsApi.recentQueries(props.target),
      favouritesApi.list(props.target).catch(() => {
        favouritesFailed.value = true
        return { favourites: [] as FavouriteView[] }
      }),
    ])
    items.value = recent.queries.map((q) => q.query)
    favourites.value = saved.favourites
  } catch (e) {
    error.value = describeError(e, t)
  } finally {
    loading.value = false
  }
  await nextTick()
  panel.value?.querySelector<HTMLElement>('button')?.focus()
}

function close(returnFocus = true): void {
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  if (returnFocus) triggerEl()?.focus()
}

function toggle(): void {
  if (open.value) close()
  else void show()
}

function pick(q: RecentQuery): void {
  close()
  emit('pick', q)
}

async function clearAll(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('query.recentClear'),
    message: t('query.recentClearConfirm'),
    confirmLabel: t('query.recentClear'),
    danger: true,
  })
  if (!ok) return
  try {
    await documentsApi.clearRecentQueries(props.target)
    items.value = []
  } catch (e) {
    error.value = describeError(e, t)
  }
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      type="button"
      class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
      :class="open ? 'bg-subtle text-fg' : ''"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :title="t('query.recent')"
      @click="toggle"
    >
      <History class="size-4" aria-hidden="true" />
      <span class="sr-only">{{ t('query.recent') }}</span>
    </button>
    <div
      v-if="open"
      :id="listId"
      ref="panel"
      data-ds-popup
      class="absolute right-0 z-30 mt-2 flex w-[min(36rem,90vw)] animate-pop flex-col gap-1 rounded-xl bg-raised p-1.5 shadow-float ring-1 ring-line"
      @keydown.escape.stop.prevent="close()"
    >
      <p v-if="loading" class="p-2 text-ui text-fg-subtle">{{ t('app.loading') }}</p>
      <p v-else-if="error" role="alert" class="p-2 text-ui text-danger">{{ error }}</p>
      <template v-else>
        <p v-if="favouritesFailed" role="alert" class="px-2 text-small text-danger">
          {{ t('library.favouritesFailed') }}
        </p>
        <section v-if="favourites.length" data-favourites class="flex flex-col gap-1">
          <h3 class="px-2 text-small font-semibold text-fg-subtle">{{ t('library.favourites') }}</h3>
          <ul class="flex max-h-48 flex-col overflow-auto">
            <li v-for="f in favourites" :key="f.id">
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui hover:bg-subtle focus-visible:bg-subtle"
                @click="pick(f.query as RecentQuery)"
              >
                <span class="font-medium">{{ f.name }}</span>
                <span v-for="tag in f.tags" :key="tag" class="rounded bg-muted px-1 text-small text-fg-muted"
                  >#{{ tag }}</span
                >
                <span v-if="f.shared" class="rounded bg-accent-soft px-1 text-small text-accent-fg">{{
                  t('library.shared')
                }}</span>
              </button>
            </li>
          </ul>
          <h3 class="px-2 pt-1 text-small font-semibold text-fg-subtle">{{ t('query.recent') }}</h3>
        </section>
        <p v-if="items.length === 0" class="p-2 text-ui text-fg-subtle">{{ t('query.recentEmpty') }}</p>
        <ul v-else :aria-label="t('query.recentList')" class="flex max-h-72 flex-col overflow-auto">
          <li v-for="(q, i) in items" :key="i">
            <button
              type="button"
              data-test="recent-query"
              class="w-full truncate rounded-lg px-2 py-1.5 text-left font-mono text-small text-fg hover:bg-subtle focus-visible:bg-subtle"
              @click="pick(q)"
            >
              {{ describe(q) }}
            </button>
          </li>
        </ul>
        <div v-if="items.length > 0" class="flex justify-end border-t border-line pt-1">
          <DsButton size="sm" variant="ghost" @click="clearAll">{{ t('query.recentClear') }}</DsButton>
        </div>
      </template>
    </div>
  </div>
</template>
