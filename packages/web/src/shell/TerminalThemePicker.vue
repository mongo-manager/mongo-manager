<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from 'lucide-vue-next'
import { usePreferencesStore } from '@/stores/preferences'
import { TERMINAL_THEMES, terminalTheme, type TerminalThemeName } from './terminalTheme'

/**
 * User request 2026-10-12 ("Terminal ekranı için tema seçimi ekle"): the terminal's theme, each shown
 * with its own background and colours, chosen at once (a radio group: one tab stop, the arrows move).
 */
const { t } = useI18n()
const preferences = usePreferencesStore()
const group = ref<HTMLElement | null>(null)

const themes = computed(() =>
  TERMINAL_THEMES.map((name) => {
    const theme = terminalTheme(preferences.dark, undefined, name)
    return {
      name,
      background: theme.background ?? '',
      dots: [theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan],
    }
  }),
)

function choose(name: TerminalThemeName): void {
  preferences.setTerminalTheme(name)
}

async function onKey(event: KeyboardEvent): Promise<void> {
  const last = TERMINAL_THEMES.length - 1
  // From the radio with the focus (review 2026-10-12, I1), else the one chosen.
  const focused = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-terminal-theme]')
  const name = (focused?.dataset.terminalTheme ?? preferences.terminalTheme) as TerminalThemeName
  const at = Math.max(0, TERMINAL_THEMES.indexOf(name))
  const to =
    event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? (at + 1) % TERMINAL_THEMES.length
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? (at + last) % TERMINAL_THEMES.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : -1
  if (to < 0) return
  event.preventDefault()
  const next = TERMINAL_THEMES[to]!
  choose(next)
  await nextTick()
  group.value?.querySelector<HTMLElement>(`[data-terminal-theme="${next}"]`)?.focus()
}
</script>

<template>
  <div
    ref="group"
    role="radiogroup"
    :aria-label="t('shell.theme.label')"
    class="flex w-72 flex-col gap-0.5"
    data-terminal-themes
    @keydown="onKey"
  >
    <button
      v-for="theme in themes"
      :key="theme.name"
      type="button"
      role="radio"
      :aria-checked="preferences.terminalTheme === theme.name"
      :tabindex="preferences.terminalTheme === theme.name ? 0 : -1"
      class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-subtle focus-visible:outline-2 focus-visible:outline-accent"
      :data-terminal-theme="theme.name"
      @click="choose(theme.name)"
    >
      <span
        class="flex h-6 w-14 shrink-0 items-center justify-center gap-0.5 rounded ring-1 ring-line ring-inset"
        :style="{ background: theme.background }"
        aria-hidden="true"
        data-theme-preview
      >
        <span
          v-for="(dot, i) in theme.dots"
          :key="i"
          class="size-1.5 rounded-full"
          :style="{ background: dot }"
        />
      </span>
      <span class="min-w-0 flex-1 truncate text-ui text-fg">{{ t(`shell.theme.names.${theme.name}`) }}</span>
      <Check
        v-if="preferences.terminalTheme === theme.name"
        class="size-3.5 shrink-0 text-accent-fg"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
