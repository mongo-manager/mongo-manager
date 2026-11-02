<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, History } from 'lucide-vue-next'
import { maskShellSecrets } from '@mongo-manager/shared/browser'
import DsPopover from '@/ds/DsPopover.vue'
import { formatCount } from '@/format'
import { resultKey, type ShellResult } from './results'

/**
 * User report 2026-10-12: the last results as a row of chips above the views "kötü duruyor". One
 * button in the result pane's header names the result shown by its command; its list holds the last
 * results, newest first, each with its command, its kind and how many documents it holds.
 *
 * Review 2026-10-12: a command is named briefly (its first line of code, cut) with its secrets masked,
 * as the audit log masks them; its first lines are the tooltip; results are told apart by their place
 * (a number may repeat after a reload).
 */
const props = defineProps<{ results: readonly ShellResult[]; currentKey: number }>()
const emit = defineEmits<{ pick: [key: number] }>()
const { t, te, locale } = useI18n()
const list = ref<HTMLElement | null>(null)

/** How long a name is, and how much of a command the tooltip shows. */
const NAME_CHARS = 80
const TOOLTIP_LINES = 6

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A result's kind in words: a known one translated, another as written ("SomeNewThing" → "Some New Thing"). */
function kind(r: ShellResult): string {
  if (r.truncated) return t('shell.results.tooLarge')
  if (!r.resultType) return t('shell.results.value')
  const key = `shell.results.kinds.${r.resultType}`
  if (te(key)) return t(key)
  return r.resultType
    .replace(/Result$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
}
/** A command's lines, its secrets masked. */
const lines = (r: ShellResult) => (r.command ? maskShellSecrets(r.command).split(/\r?\n/) : [])
/** What a result is called: its first line of code (not a comment), cut; else its kind. */
function title(r: ShellResult): string {
  const code = lines(r)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('//'))
  return code ? cut(code, NAME_CHARS) : kind(r)
}
/** The command's first lines, each cut: what the tooltip shows. */
function full(r: ShellResult): string {
  const all = lines(r)
  const shown = all.slice(0, TOOLTIP_LINES).map((l) => cut(l, 120))
  return all.length > TOOLTIP_LINES ? [...shown, '…'].join('\n') : shown.join('\n')
}
const detail = (r: ShellResult) =>
  [
    `#${resultKey(r)}`,
    kind(r),
    ...(r.documents
      ? [t('shell.results.docs', { n: formatCount(r.documents.length, locale.value) }, r.documents.length)]
      : []),
  ].join(' · ')

const current = computed(
  () => props.results.find((r) => resultKey(r) === props.currentKey) ?? props.results[0]!,
)

function pick(key: number, close: () => void): void {
  emit('pick', key)
  close()
}

/** A radio group: the arrows (round the list), Home and End move the choice; it stays open. */
async function onKey(event: KeyboardEvent): Promise<void> {
  // Alt (or Ctrl, Cmd) and an arrow are the browser's (back, forward).
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const keys = props.results.map(resultKey)
  const focused = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-result-pick]')
  const at = Math.max(0, keys.indexOf(Number(focused?.dataset.resultPick ?? props.currentKey)))
  const count = keys.length
  const to =
    event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? (at + 1) % count
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? (at + count - 1) % count
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : -1
  if (to < 0) return
  event.preventDefault()
  emit('pick', keys[to]!)
  await nextTick()
  list.value?.querySelector<HTMLElement>(`[data-result-pick="${keys[to]}"]`)?.focus()
}
</script>

<template>
  <div class="ml-auto min-w-0" data-result-history>
    <DsPopover
      :label="t('shell.results.history', { current: `#${resultKey(current)} ${title(current)}` })"
      :dialog-label="t('shell.results.historyTitle')"
      placement="bottom-end"
      trigger-class="flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-small text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
      panel-class="w-[min(28rem,90vw)]"
    >
      <template #trigger>
        <History class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="shrink-0 text-fg-subtle tabular-nums">#{{ resultKey(current) }}</span>
        <span
          class="max-w-56 truncate font-mono text-fg"
          :title="full(current) || undefined"
          data-result-full
          >{{ title(current) }}</span
        >
        <ChevronDown class="size-3.5 shrink-0" aria-hidden="true" />
      </template>
      <template #default="{ close }">
        <div
          ref="list"
          role="radiogroup"
          :aria-label="t('shell.results.pick')"
          class="flex flex-col gap-0.5"
          @keydown="onKey"
        >
          <button
            v-for="r in results"
            :key="resultKey(r)"
            type="button"
            role="radio"
            :aria-checked="resultKey(r) === resultKey(current)"
            :tabindex="resultKey(r) === resultKey(current) ? 0 : -1"
            :title="full(r) || undefined"
            class="flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-120 hover:bg-subtle focus-visible:outline-2 focus-visible:outline-accent"
            :class="resultKey(r) === resultKey(current) ? 'bg-accent-soft/60' : ''"
            :data-result-pick="resultKey(r)"
            @click="pick(resultKey(r), close)"
          >
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="line-clamp-2 font-mono text-small break-all text-fg">{{ title(r) }}</span>
              <span class="truncate text-caption text-fg-subtle tabular-nums">{{ detail(r) }}</span>
            </span>
            <Check
              v-if="resultKey(r) === resultKey(current)"
              class="mt-0.5 size-3.5 shrink-0 text-accent-fg"
              aria-hidden="true"
            />
          </button>
        </div>
      </template>
    </DsPopover>
  </div>
</template>
