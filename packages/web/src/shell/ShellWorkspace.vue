<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  ChevronRight,
  Eraser,
  History,
  Palette,
  RotateCcw,
  Save,
  Square,
  SquareTerminal,
} from 'lucide-vue-next'
import type { SnippetView } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { documentKeys, documentsApi } from '@/api/documents'
import { snippetsApi } from '@/api/snippets'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'
import { useShellInbox } from '@/stores/shellInbox'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import DsButton from '@/ds/DsButton.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsKbd from '@/ds/DsKbd.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsPopover from '@/ds/DsPopover.vue'
import type { DsMenuItem } from '@/ds/menu'
import DsResizeHandle from '@/ds/DsResizeHandle.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import { COLOR_CLASSES } from '@/connections/colors'
import ShellView from './ShellView.vue'
import ResultPane from './ResultPane.vue'
import SaveSnippetDialog from './SaveSnippetDialog.vue'
import SnippetRunDialog from './SnippetRunDialog.vue'
import TerminalThemePicker from './TerminalThemePicker.vue'
import { shellCompleter } from './complete/provider'
import { listsOf } from './listsQuery'
import { ResultBuffer, type ShellResult } from './results'

/**
 * User request 2026-10-11 (the shell's redesign): one page in the app's look — a header saying where
 * the shell runs (the connection, the database it is on) and its state, with its actions (Stop, Clear,
 * and a menu: save as snippet, clear history, restart); the terminal, the results beside it (a
 * resizable panel; tabs on a narrow screen); the keys in a status bar.
 *
 * User request 2026-10-12 ("kod düzenleyici alanını kaldır… hiç bir işe yaramıyor"): the terminal is
 * the one place code is typed, as in mongosh — code of many lines typed (Shift+Enter) or pasted there,
 * and run with Enter. Completion knows the database's collections, and a collection's field names from
 * a small schema sample fetched the first time that collection is completed.
 */
/** `tabId`: the tab it is in, so its shell is the same one again after a reload. */
const props = defineProps<{ connectionId: string; db: string; tabId?: string }>()
const { t } = useI18n()
const uid = useId()

type ShellViewApi = {
  run(code: string): boolean
  insert(code: string): 'inserted' | 'running' | 'tooLarge'
  current(): string
  cancel(): void
  complete(code: string): Promise<string[]>
  clear(): void
  restart(): void
  clearHistory(): Promise<'cleared' | 'cancelled' | 'failed'>
  running: boolean
  status: 'connecting' | 'ready' | 'running' | 'closed'
  runningSince: number | null
}
const view = ref<ShellViewApi | null>(null)

// The database the shell is on: the one opened, until `use` changes it (final review M6).
const shellDb = ref(props.db)
const { data: collections } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, shellDb.value)),
  queryFn: () => connectionsApi.collections(props.connectionId, shellDb.value),
})
const queryClient = useQueryClient()
/**
 * What was typed has run (or ended some other way): the connection's databases and their collections
 * are read again, so one it made completes and shows in the tree — in the database it was made in,
 * after `use` too (found by e2e 2026-10-12; review 2026-10-12, minor 6).
 */
const refreshCollections = (): void =>
  void queryClient.invalidateQueries({ predicate: listsOf(props.connectionId) })
const SAMPLE = 100
/** Sampled field names, by database and collection. */
const fields = reactive(new Map<string, readonly string[]>())
function fieldsOf(coll: string): readonly string[] {
  const db = shellDb.value
  const key = JSON.stringify([db, coll])
  if (!fields.has(key)) {
    fields.set(key, [])
    const target = { connectionId: props.connectionId, db, coll }
    queryClient
      .fetchQuery({
        queryKey: documentKeys.schema(target, SAMPLE),
        queryFn: () => documentsApi.schema(target, SAMPLE),
        staleTime: 5 * 60_000,
      })
      // Array elements ("a[]") are not keys one can type.
      .then((analysis) =>
        fields.set(
          key,
          analysis.fields.map((f) => f.path).filter((p) => !p.includes('[]')),
        ),
      )
      .catch(() => undefined)
  }
  return fields.get(key)!
}

const complete = shellCompleter({
  context: () => ({ collections: (collections.value ?? []).map((c) => c.name), fields: fieldsOf }),
  worker: (code) => view.value?.complete(code) ?? Promise.resolve([]),
  busy: () => view.value?.running ?? false,
})
const running = computed(() => view.value?.running ?? false)
const run = (code: string): boolean => view.value?.run(code) ?? false
const cancel = (): void => view.value?.cancel()

// Where it runs: the connection (its colour and name) and the database the shell is on.
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.value?.find((c) => c.id === props.connectionId) ?? null)
const status = computed(() => view.value?.status ?? 'connecting')
const DOT = { connecting: 'connecting', ready: 'connected', running: 'connected', closed: 'idle' } as const
/** Seconds the command has been running, counted while it runs. */
const now = ref(Date.now())
let ticking: ReturnType<typeof setInterval> | undefined
watch(running, (on) => {
  clearInterval(ticking)
  now.value = Date.now()
  if (on) ticking = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(ticking))
/** The connection's colour as the app draws it (review I6: its name is no CSS colour). */
const dotClass = computed(() =>
  connection.value?.color ? COLOR_CLASSES[connection.value.color] : 'bg-line-strong',
)
const elapsed = computed(() => {
  const since = view.value?.runningSince
  return running.value && since ? Math.max(0, Math.floor((now.value - since) / 1000)) : null
})

const dialogs = useDialogStore()
const menu = computed<DsMenuItem[]>(() => [
  { id: 'save', label: t('shell.actions.saveSnippet'), icon: Save },
  { id: 'history', label: t('shell.clearHistory'), icon: History, separator: true },
  { id: 'restart', label: t('shell.actions.restart'), icon: RotateCcw, danger: true },
])
async function onMenu(id: string): Promise<void> {
  if (id === 'save') saveSnippet()
  else if (id === 'history') {
    // The command history and the results go together (user report 2026-10-12), said either way.
    const outcome = await view.value?.clearHistory()
    if (outcome === 'cleared') {
      clearResults()
      toasts.push({ kind: 'success', message: t('shell.historyCleared') })
    } else if (outcome === 'failed') toasts.push({ kind: 'error', message: t('shell.historyNotCleared') })
  } else if (
    id === 'restart' &&
    (await dialogs.confirm({
      title: t('shell.restart.title'),
      message: t('shell.restart.message'),
      confirmLabel: t('shell.actions.restart'),
      danger: true,
    }))
  ) {
    // A new shell starts with no results of the one before.
    clearResults()
    view.value?.restart()
  }
}

/**
 * The shell's keys, in the status bar; on a screen not wide enough for all of them, those marked
 * `wide` give way (review 2026-10-12, minor 20: the bar clipped).
 */
const KEYS = [
  { keys: ['Enter'], label: 'run', wide: false },
  { keys: ['Shift', 'Enter'], label: 'newline', wide: false },
  { keys: ['Ctrl', 'Enter'], label: 'runNow', wide: true },
  { keys: ['Ctrl', 'C'], label: 'stop', wide: false },
  { keys: ['Ctrl', 'L'], label: 'clear', wide: true },
  { keys: ['↑', '↓'], label: 'history', wide: false },
  { keys: ['Ctrl', 'R'], label: 'search', wide: true },
  { keys: ['Tab'], label: 'complete', wide: false },
  { keys: ['Shift', 'Tab'], label: 'leave', wide: true },
] as const

/**
 * The results panel's width beside the terminal (a wide screen), never leaving the terminal fewer
 * than MIN_TERMINAL pixels of the page's body (review 2026-10-11: the assistant panel may be open).
 * User report 2026-10-12 ("sağ taraftaki sonuçlar kullanışsız"): remembered in this browser, as wide
 * as the terminal leaves room for, and the whole width when asked (the terminal out of sight).
 */
const WIDTH_KEY = 'mm:shell-results-width'
const MIN_RESULTS = 320
const MIN_TERMINAL = 420
/** The widest before the page is measured: the terminal's first fit never squeezed (review M16). */
const MAX_UNMEASURED = 900
/** The widest a stored width is taken at (a value tampered with is not). */
const MAX_STORED = 4000
function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n >= MIN_RESULTS && n <= MAX_STORED ? Math.round(n) : 440
  } catch {
    return 440
  }
}
const resultsWidth = ref(storedWidth())
/** Written once the moving stops, never on every step of a drag (review M16). */
let storing: ReturnType<typeof setTimeout> | undefined
function storeWidth(): void {
  clearTimeout(storing)
  storing = undefined
  try {
    localStorage.setItem(WIDTH_KEY, String(resultsWidth.value))
  } catch {
    // Storage refused (a private window): the width lasts this visit.
  }
}
watch(resultsWidth, () => {
  clearTimeout(storing)
  storing = setTimeout(storeWidth, 300)
})
onBeforeUnmount(() => {
  if (storing !== undefined) storeWidth()
})
/** The results across the whole width, the terminal hidden (its session stays). */
const resultsWide = ref(false)
const body = ref<HTMLElement | null>(null)
const bodyWidth = ref(0)
let measured: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !body.value) return
  measured = new ResizeObserver(([entry]) => (bodyWidth.value = entry?.contentRect.width ?? 0))
  measured.observe(body.value)
})
onBeforeUnmount(() => measured?.disconnect())
const maxResults = computed(() =>
  bodyWidth.value > 0 ? Math.max(MIN_RESULTS, bodyWidth.value - MIN_TERMINAL) : MAX_UNMEASURED,
)
const shownWidth = computed(() => Math.min(resultsWidth.value, maxResults.value))

// Phase 3a-2 spec §3.5: snippets. One opened from the Library or the palette arrives through the
// inbox; its form puts the filled code in the terminal's line, where the user reads it and runs it.
const inbox = useShellInbox()
const toasts = useToastStore()
const runSnippet = ref<SnippetView | null>(null)
const saveCode = ref<string | null>(null)
watch(
  () => inbox.pending[props.connectionId],
  async (snippetId) => {
    if (!snippetId || inbox.take(props.connectionId) === null) return
    try {
      // The one snippet, not the whole (bounded) list it might be left out of (final review M8).
      runSnippet.value = await snippetsApi.get(props.connectionId, snippetId)
    } catch (e) {
      const gone = e instanceof ApiError && e.code === 'NOT_FOUND'
      toasts.push({ kind: 'error', message: gone ? t('shell.snippets.gone') : describeError(e, t) })
    }
  },
  { immediate: true },
)
/**
 * The filled code goes into the terminal's line once the form has closed (its closing gives the focus
 * back to what opened it: the terminal takes it after — review 2026-10-12, I13); not put in, it says
 * why.
 */
async function insertSnippet(code: string): Promise<void> {
  runSnippet.value = null
  await nextTick()
  const outcome = view.value?.insert(code)
  if (outcome === 'running') toasts.push({ kind: 'error', message: t('shell.snippets.notInsertedRunning') })
  else if (outcome === 'tooLarge')
    toasts.push({ kind: 'error', message: t('shell.snippets.notInsertedLarge') })
}
/** Saves the line being typed as a snippet, else the last code run; with neither, says so. */
function saveSnippet(): void {
  const code = view.value?.current() ?? ''
  if (code.trim()) saveCode.value = code
  else toasts.push({ kind: 'info', message: t('shell.snippets.nothing') })
}

// Phase 3a-2: the last results, in memory only, for the result pane.
const results = reactive(new ResultBuffer())
/** On a narrow screen the terminal and the result pane are two tabs. */
type NarrowTab = 'terminal' | 'result'
const narrowTab = ref<NarrowTab>('terminal')
/** Results that came while the terminal tab was shown (a narrow screen): said on the Results tab. */
const unseen = ref(false)
/**
 * The results cleared and not brought back yet, with how they were shown and the toast saying so: one
 * for every clear since (review 2026-10-13, M3: two Undos put them back out of order).
 */
let undo: { gone: ShellResult[]; wide: boolean; toast: number } | null = null
/** The empty pane offers them back, with no time limit (review 2026-10-13, I1: the toast's Undo timed out). */
const restorable = ref(false)
function forgetUndo(): void {
  if (undo) toasts.dismiss(undo.toast)
  undo = null
  restorable.value = false
}
/**
 * The results gone from the pane. The terminal comes back from behind results in full width (review
 * 2026-10-12, I2: nothing was left to bring it).
 */
function wipeResults(): ShellResult[] {
  resultsWide.value = false
  unseen.value = false
  return results.clear()
}
/** The results forgotten for good: the history cleared or the shell restarted (review 2026-10-13, M2). */
function clearResults(): void {
  forgetUndo()
  wipeResults()
}
/**
 * The pane's Clear and Clear the screen ask nothing, so they say so with an Undo, which brings back
 * every clear not undone yet (user request 2026-10-13: "ekranı temizle sonuçlarıda temizlesin").
 */
function clearResultsAsked(): void {
  const wide = resultsWide.value
  const gone = wipeResults()
  if (!gone.length) return
  const before = undo
  if (before) toasts.dismiss(before.toast)
  const entry = { gone: [...gone, ...(before?.gone ?? [])], wide, toast: 0 }
  undo = entry
  restorable.value = true
  entry.toast = toasts.push({
    kind: 'info',
    message: t('shell.results.cleared'),
    actions: [{ label: t('shell.results.undo'), run: restoreResults }],
  })
}
/** Brings the results cleared back as they were shown, behind any that came since (review M4). */
function restoreResults(): void {
  const entry = undo
  if (!entry) return
  forgetUndo()
  results.restore(entry.gone)
  resultsWide.value = entry.wide
  if (narrowTab.value !== 'result') unseen.value = true
}
const onResult = (result: ShellResult): void => {
  results.push(result)
  if (narrowTab.value !== 'result') unseen.value = true
}
const NARROW: NarrowTab[] = ['terminal', 'result']
const tabIds = { terminal: `${uid}-terminal`, result: `${uid}-results` }
function showTab(tab: NarrowTab, focus = false): void {
  narrowTab.value = tab
  if (tab === 'result') unseen.value = false
  if (focus) void nextTick(() => document.getElementById(`${tabIds[tab]}-tab`)?.focus())
}
/** The arrows, Home and End move between the tabs (the ARIA tab pattern). */
function onTabKey(event: KeyboardEvent): void {
  const i = NARROW.indexOf(narrowTab.value)
  const next =
    event.key === 'ArrowRight'
      ? NARROW[(i + 1) % NARROW.length]
      : event.key === 'ArrowLeft'
        ? NARROW[(i + NARROW.length - 1) % NARROW.length]
        : event.key === 'Home'
          ? NARROW[0]
          : event.key === 'End'
            ? NARROW.at(-1)
            : undefined
  if (!next) return
  event.preventDefault()
  showTab(next, true)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-canvas" data-shell-workspace>
    <!-- Where it runs, its state, and what it does. -->
    <header
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2.5"
      data-shell-header
    >
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg"
        aria-hidden="true"
      >
        <SquareTerminal class="size-4" />
      </span>
      <div class="flex min-w-0 flex-col">
        <h2 class="text-ui leading-tight font-semibold text-fg">{{ t('shell.section') }}</h2>
        <p class="flex min-w-0 items-center gap-1 text-small text-fg-muted">
          <span
            class="size-2 shrink-0 rounded-full"
            :class="dotClass"
            aria-hidden="true"
            data-shell-connection-dot
          />
          <span class="truncate">{{ connection?.name ?? connectionId }}</span>
          <ChevronRight class="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />
          <span class="truncate font-mono text-fg" data-shell-db>{{ shellDb }}</span>
        </p>
      </div>
      <span
        class="inline-flex h-6 items-center gap-1.5 rounded-full bg-subtle px-2.5 text-small font-medium text-fg-muted ring-1 ring-line ring-inset"
        data-shell-status
      >
        <span role="status" class="inline-flex items-center gap-1.5">
          <DsStatusDot :state="DOT[status]" :label="t(`shell.status.${status}`)" />
          <span aria-hidden="true">{{ t(`shell.status.${status}`) }}</span>
        </span>
        <!-- Counted each second: shown, never read out (review I7). -->
        <span
          v-if="elapsed !== null"
          class="text-fg-subtle tabular-nums"
          aria-hidden="true"
          data-shell-elapsed
          >· {{ t('shell.elapsed', { s: elapsed }) }}</span
        >
      </span>
      <div class="ml-auto flex items-center gap-1">
        <DsButton
          v-if="running"
          size="sm"
          variant="danger"
          :icon="Square"
          data-shell-stop
          aria-keyshortcuts="Control+C"
          @click="cancel"
        >
          {{ t('shell.actions.stop') }}
        </DsButton>
        <DsIconButton
          size="sm"
          :icon="Eraser"
          :label="t('shell.actions.clear')"
          :shortcut="['Ctrl', 'L']"
          data-shell-clear
          @click="view?.clear()"
        />
        <DsTooltip :text="t('shell.actions.more')">
          <span data-shell-menu>
            <DsMenu
              :label="t('shell.actions.more')"
              :items="menu"
              focusable
              trigger-class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-[background-color,color] duration-120 ease-out-soft hover:bg-subtle hover:text-fg"
              @select="onMenu"
            />
          </span>
        </DsTooltip>
      </div>
    </header>

    <!-- On a narrow screen the terminal and the results are two tabs. -->
    <div
      role="tablist"
      :aria-label="t('shell.section')"
      class="flex shrink-0 gap-1 border-b border-line bg-surface px-3 lg:hidden"
    >
      <button
        v-for="tab in NARROW"
        :id="`${tabIds[tab]}-tab`"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="narrowTab === tab"
        :aria-controls="tabIds[tab]"
        :tabindex="narrowTab === tab ? 0 : -1"
        class="relative -mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-ui"
        :class="narrowTab === tab ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted'"
        data-shell-narrow-tab
        @click="showTab(tab)"
        @keydown="onTabKey"
      >
        {{ t(tab === 'terminal' ? 'shell.results.terminal' : 'shell.results.title') }}
        <span v-if="tab === 'result' && unseen" class="size-1.5 rounded-full bg-accent" data-shell-new-results
          ><span class="sr-only">{{ t('shell.results.new') }}</span></span
        >
      </button>
    </div>

    <div ref="body" class="flex min-h-0 flex-1 gap-3 p-3">
      <div
        :id="tabIds.terminal"
        class="flex min-h-0 min-w-0 flex-1 flex-col"
        :class="[narrowTab === 'terminal' ? '' : 'max-lg:hidden', resultsWide ? 'lg:hidden' : '']"
        data-shell-terminal-column
        :aria-labelledby="`${tabIds.terminal}-tab`"
      >
        <div
          class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs"
        >
          <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <SquareTerminal class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span class="text-small font-semibold tracking-wide text-fg-muted uppercase">{{
              t('shell.terminalTitle')
            }}</span>
            <!-- User request 2026-10-12: the terminal's theme, chosen where the terminal is. -->
            <div class="ml-auto" data-shell-theme>
              <DsTooltip :text="t('shell.theme.label')">
                <DsPopover
                  :label="t('shell.theme.label')"
                  placement="bottom-end"
                  trigger-class="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg"
                >
                  <template #trigger><Palette class="size-3.5" aria-hidden="true" /></template>
                  <TerminalThemePicker />
                </DsPopover>
              </DsTooltip>
            </div>
          </div>
          <div class="min-h-0 flex-1">
            <ShellView
              ref="view"
              :connection-id="connectionId"
              :db="db"
              :completer="complete"
              :session-key="tabId"
              @result="onResult"
              @db="shellDb = $event"
              @ran="refreshCollections"
              @cleared="clearResultsAsked"
            />
          </div>
        </div>
      </div>
      <div
        :id="tabIds.result"
        class="relative flex min-h-0 flex-col max-lg:flex-1"
        :class="[
          narrowTab === 'result' ? '' : 'max-lg:hidden',
          // Across the whole width it shrinks to the page, its table scrolling inside.
          resultsWide ? 'min-w-0 lg:flex-1' : 'shrink-0 lg:w-[var(--results-w)]',
        ]"
        data-shell-results-column
        :style="{ '--results-w': `${shownWidth}px` }"
        :aria-labelledby="`${tabIds.result}-tab`"
      >
        <DsResizeHandle
          v-if="!resultsWide"
          :value="shownWidth"
          class="max-lg:hidden"
          :min="MIN_RESULTS"
          :max="maxResults"
          :label="t('shell.results.resize')"
          edge="left"
          @update:value="resultsWidth = $event"
        />
        <div
          class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs"
        >
          <ResultPane
            :connection-id="connectionId"
            :db="shellDb"
            :results="results.items"
            :wide="resultsWide"
            :restorable="restorable"
            @more="run('it')"
            @wide="resultsWide = $event"
            @clear="clearResultsAsked"
            @restore="restoreResults"
          />
        </div>
      </div>
    </div>

    <!-- The keys, in sight on a wide screen (where there is a keyboard to press them). -->
    <footer
      class="flex h-8 shrink-0 items-center justify-end gap-4 overflow-hidden border-t border-line bg-surface px-4 text-caption whitespace-nowrap text-fg-subtle max-lg:hidden pr-[max(1rem,var(--mm-launcher-clearance,0px))]"
      data-shell-statusbar
    >
      <span
        v-for="k in KEYS"
        :key="k.label"
        class="flex items-center gap-1"
        :class="k.wide ? 'max-2xl:hidden' : ''"
      >
        <DsKbd v-for="key in k.keys" :key="key">{{ key }}</DsKbd>
        {{ t(`shell.keys.${k.label}`) }}
      </span>
    </footer>

    <SaveSnippetDialog
      v-if="saveCode !== null"
      :connection-id="connectionId"
      :code="saveCode"
      @saved="saveCode = null"
      @close="saveCode = null"
    />
    <SnippetRunDialog
      v-if="runSnippet"
      :snippet="runSnippet"
      @insert="insertSnippet"
      @close="runSnippet = null"
    />
  </div>
</template>
