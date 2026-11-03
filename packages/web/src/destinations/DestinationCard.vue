<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Lock, LockOpen, Users } from 'lucide-vue-next'
import { DESTINATION_ICON as ICON } from './icons'
import type { DestinationView } from '@mongo-manager/shared/browser'
import DsMenu from '@/ds/DsMenu.vue'
import { formatBytes, formatRelative } from '@/format'
import { useReasonText } from './errors'

/**
 * D1: a destination at a glance — type, health, last test, usage, who may use it. Final review: a
 * running test shows on the card, a failed one says why, and the last test time follows the clock.
 */
const props = defineProps<{ destination: DestinationView; testing?: boolean; now?: number }>()
const emit = defineEmits<{ edit: []; test: []; remove: [] }>()
const { t, locale } = useI18n()
const reasonWords = useReasonText()
const d = computed(() => props.destination)
const pill = computed(() =>
  d.value.status.state === 'ok'
    ? {
        text: t('destinations.status.ok'),
        cls: 'bg-success-soft text-success',
      }
    : d.value.status.state === 'reconnect'
      ? {
          text: t('destinations.status.reconnect'),
          cls: 'bg-warning-soft text-warning',
        }
      : d.value.status.state === 'failed'
        ? {
            text: t('destinations.status.failed'),
            cls: 'bg-danger-soft text-danger',
          }
        : {
            text: t('destinations.status.unknown'),
            cls: 'bg-subtle text-fg-muted',
          },
)
/** Why it needs attention, in the words of its type (a WebDAV password is no access key). */
const reasonText = computed(() => {
  const r = d.value.status.reason
  if (!r || d.value.status.state === 'ok' || d.value.status.state === 'unknown') return null
  // Short names review 8 (M-6): which folder refusal, and the name refused, as the test said.
  return reasonWords(r, d.value.type, d.value.status)
})
const checkedAgo = computed(() =>
  d.value.status.checkedAt
    ? formatRelative(Math.min(0, d.value.status.checkedAt - (props.now ?? Date.now())), locale.value)
    : null,
)
/** A malformed address never takes the page down: it is shown as written. */
const hostOf = (url: string | undefined) => {
  try {
    return new URL(String(url)).host
  } catch {
    return String(url ?? '')
  }
}
const where = computed(() => {
  const c = d.value.config as Record<string, string>
  if (d.value.type === 's3') return `${c.bucket}${c.prefix ? `/${c.prefix}` : ''} · ${c.region}`
  if (d.value.type === 'webdav') return `${hostOf(c.url)}${c.folder ? `/${c.folder}` : ''}`
  if (d.value.type === 'gcs') return `${c.bucket}${c.prefix ? `/${c.prefix}` : ''} · ${c.storageClass}`
  if (d.value.type === 'azure') return `${c.account}/${c.container}${c.prefix ? `/${c.prefix}` : ''}`
  if (d.value.type === 'sftp') return `${c.username}@${c.host}${c.folder ? `:${c.folder}` : ''}`
  if (d.value.type === 'gdrive') return d.value.status.account ?? t('destinations.type.gdrive')
  return tail(c.path ?? '')
})
/** A long folder keeps its last three parts, which tell folders apart; the whole path is its title. */
function tail(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(sep).filter(Boolean)
  return parts.length > 3 ? `…${sep}${parts.slice(-3).join(sep)}` : path
}
const whereTitle = computed(() =>
  d.value.type === 'folder' ? String((d.value.config as Record<string, string>).path ?? '') : undefined,
)
const usage = computed(() =>
  t(
    'destinations.card.usage',
    { count: d.value.usage.copies, bytes: formatBytes(d.value.usage.bytes, locale.value) },
    d.value.usage.copies,
  ),
)
const items = computed(() => [
  { id: 'edit', label: t('destinations.card.edit') },
  { id: 'test', label: t('destinations.card.test') },
  { id: 'remove', label: t('destinations.card.remove'), danger: true },
])
function onSelect(id: string): void {
  if (id === 'edit') emit('edit')
  else if (id === 'test') emit('test')
  else if (id === 'remove') emit('remove')
}
</script>

<template>
  <article
    class="group flex flex-col gap-4 rounded-card border border-line bg-surface p-5 transition-shadow duration-200 hover:shadow-md"
    :aria-label="d.name"
    :aria-busy="testing ? 'true' : 'false'"
  >
    <header class="flex items-start gap-3">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
        <component :is="ICON[d.type]" class="size-5 text-accent-fg" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="line-clamp-2 font-semibold break-words text-fg" :title="d.name">
          {{ d.name }}
        </h3>
        <p class="truncate text-ui text-fg-subtle" :title="whereTitle">{{ where }}</p>
      </div>
      <DsMenu
        focusable
        touch
        :items="items"
        :label="t('destinations.card.actions', { name: d.name })"
        @select="onSelect"
      />
    </header>
    <dl class="grid grid-cols-2 gap-3 text-ui">
      <div>
        <dt class="text-small text-fg-subtle">{{ t('destinations.card.lastTest') }}</dt>
        <dd class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
          <span
            v-if="testing"
            class="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-small font-medium text-accent-fg"
            ><Loader2 class="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />{{
              t('destinations.card.testing')
            }}</span
          >
          <span v-else class="rounded-full px-2 py-0.5 text-small font-medium" :class="pill.cls">{{
            pill.text
          }}</span>
          <span v-if="checkedAgo" class="font-medium text-fg">{{ checkedAgo }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-small text-fg-subtle">{{ t('destinations.card.sent') }}</dt>
        <dd class="font-medium text-fg tabular-nums">{{ usage }}</dd>
      </div>
    </dl>
    <p
      v-if="reasonText && !testing"
      class="-mt-1 rounded-lg px-3 py-2 text-ui"
      :class="d.status.state === 'reconnect' ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger'"
      data-status-reason
    >
      {{ reasonText }}
    </p>
    <footer class="flex items-center gap-2 text-small text-fg-subtle">
      <component :is="d.policy.encryptedOnly ? Lock : LockOpen" class="size-3.5" aria-hidden="true" />
      <span>{{
        d.policy.encryptedOnly ? t('destinations.card.encryptedOnly') : t('destinations.card.anyFormat')
      }}</span>
      <span class="mx-1 h-3 w-px bg-muted" aria-hidden="true" />
      <Users class="size-3.5" aria-hidden="true" />
      <span class="truncate">{{
        d.grants.length ? d.grants.map((g) => g.username).join(', ') : t('destinations.card.adminsOnly')
      }}</span>
    </footer>
  </article>
</template>
