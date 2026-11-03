<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { History, Pencil, Trash2 } from 'lucide-vue-next'
import DsPopover from '@/ds/DsPopover.vue'
import { aiChatApi, aiChatKeys } from '@/api/aiChat'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { usePreferencesStore } from '@/stores/preferences'
import { formatRelative } from '@/format'
import { describeError } from '@/api/errors'
import { useAiStatus } from '../useAi'
import { useAssistantStore } from './store'

/** Spec §5: my chats — filter, open, delete; delete all; the retention in words. */
const { t } = useI18n()
const store = useAssistantStore()
const dialogs = useDialogStore()
const toasts = useToastStore()
const preferences = usePreferencesStore()
const status = useAiStatus()
const list = useQuery({ queryKey: aiChatKeys.list, queryFn: aiChatApi.list })
// Third review of the floating window (I-1): closed with the window (its focus goes back there).
const popover = ref<InstanceType<typeof DsPopover> | null>(null)
defineExpose({ close: () => popover.value?.close(false) })
watch(
  () => store.version,
  () => void list.refetch(),
)
const filter = ref('')
const shown = computed(() => {
  const q = filter.value.trim().toLocaleLowerCase()
  return (list.data.value ?? []).filter(
    (c) =>
      !q ||
      (c.title ?? '').toLocaleLowerCase().includes(q) ||
      (c.namespace ?? '').toLocaleLowerCase().includes(q),
  )
})
const keep = computed(() => {
  const c = status.data.value?.chat
  if (!c) return ''
  return c.days === 0 ? t('ai.chat.history.keepMemory') : t('ai.chat.history.keep', c, c.days)
})
const titleOf = (title: string | null) => title ?? t('ai.chat.unreadableTitle')

async function open(id: string, close: (focus?: boolean) => void): Promise<void> {
  // Fourth review of the floating window (M-C): focus back on History, in the window.
  close(true)
  // The next opening shows every chat again.
  filter.value = ''
  await store.openChat(id)
}
async function remove(id: string, title: string | null, close: (focus?: boolean) => void): Promise<void> {
  // Fifth review of the floating window (6): focus back on History, in the window, never the body.
  close(true)
  const ok = await dialogs.confirm({
    title: t('ai.chat.history.deleteTitle', { title: titleOf(title) }),
    message: t('ai.chat.history.deleteMessage'),
    confirmLabel: t('ai.chat.history.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await aiChatApi.remove(id)
  } catch (e) {
    // Final review minor 19.
    toasts.push({ kind: 'error', message: describeError(e, t) })
    await list.refetch()
    return
  }
  if (store.chatId === id) store.newChat()
  toasts.push({ kind: 'success', message: t('ai.chat.history.deleted') })
  await list.refetch()
}
/** Final review minor 11: any chat can be renamed from its row. */
async function rename(id: string, title: string | null, close: (focus?: boolean) => void): Promise<void> {
  close(true)
  const next = await dialogs.prompt({
    title: t('ai.chat.renameTitle'),
    message: '',
    confirmLabel: t('ai.chat.rename'),
    input: { type: 'text', label: t('ai.chat.renameLabel'), value: title ?? '', autocomplete: 'off' },
  })
  const text = next?.trim().slice(0, 60)
  if (!text) return
  try {
    await aiChatApi.rename(id, text)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    return
  }
  if (store.chat && store.chatId === id) store.chat.title = text
  await list.refetch()
}
async function removeAll(close: (focus?: boolean) => void): Promise<void> {
  close(true)
  const ok = await dialogs.confirm({
    title: t('ai.chat.history.deleteAllTitle'),
    message: t('ai.chat.history.deleteAllMessage'),
    confirmLabel: t('ai.chat.history.deleteAll'),
    danger: true,
  })
  if (!ok) return
  let removed: number
  try {
    ;({ removed } = await aiChatApi.removeAll())
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
    return
  }
  store.newChat()
  toasts.push({ kind: 'success', message: t('ai.chat.history.deletedAll', { n: removed }, removed) })
  await list.refetch()
}
</script>

<template>
  <DsPopover
    ref="popover"
    :label="t('ai.chat.history.button')"
    trigger-class="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
    panel-class="w-80"
    @open="list.refetch()"
  >
    <template #trigger><History class="size-4" aria-hidden="true" /></template>
    <template #default="{ close }">
      <div class="flex flex-col gap-2 p-2">
        <input
          v-model="filter"
          type="search"
          :aria-label="t('ai.chat.history.filter')"
          :placeholder="t('ai.chat.history.filter')"
          class="h-8 rounded-md border border-line bg-surface px-2 text-ui"
        />
        <p v-if="!(list.data.value ?? []).length" class="px-1 py-3 text-center text-ui text-fg-subtle">
          {{ t('ai.chat.history.empty') }}
        </p>
        <p v-else-if="!shown.length" class="px-1 py-3 text-center text-ui text-fg-subtle">
          {{ t('ai.chat.history.none') }}
        </p>
        <ul v-else class="max-h-80 overflow-y-auto">
          <li v-for="c in shown" :key="c.id" class="group flex items-center gap-1 rounded-md hover:bg-subtle">
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer px-2 py-1.5 text-left"
              :class="c.id === store.chatId ? 'text-accent-fg' : ''"
              :aria-current="c.id === store.chatId ? 'true' : undefined"
              @click="open(c.id, close)"
            >
              <span class="block truncate text-ui font-medium">{{ titleOf(c.title) }}</span>
              <span class="block truncate text-small text-fg-subtle"
                >{{ c.namespace ?? t('ai.chat.history.general') }} ·
                {{ formatRelative(c.updatedAt - Date.now(), preferences.locale) }}</span
              >
            </button>
            <button
              type="button"
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              :aria-label="t('ai.chat.history.rename', { title: titleOf(c.title) })"
              @click="rename(c.id, c.title, close)"
            >
              <Pencil class="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="mr-1 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              :aria-label="t('ai.chat.history.deleteOne', { title: titleOf(c.title) })"
              @click="remove(c.id, c.title, close)"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <div class="flex flex-col gap-2 border-t border-line px-1 pt-2">
          <p v-if="keep" class="text-small text-fg-subtle">{{ keep }}</p>
          <button
            v-if="(list.data.value ?? []).length"
            type="button"
            class="cursor-pointer self-start text-small font-medium text-danger hover:underline"
            @click="removeAll(close)"
          >
            {{ t('ai.chat.history.deleteAll') }}
          </button>
        </div>
      </div>
    </template>
  </DsPopover>
</template>
