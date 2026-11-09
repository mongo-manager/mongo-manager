// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, type ComputedRef } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import type { ChartTheme } from './options'

const token = (name: string, fallback: string) =>
  (typeof document !== 'undefined' &&
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()) ||
  fallback

/** Chart colours from the theme tokens; recomputed when light and dark switch (phase 1j spec §1). */
export function useChartTheme(): ComputedRef<ChartTheme> {
  const preferences = usePreferencesStore()
  return computed(() => {
    const dark = preferences.dark
    // Read again when the accent changes (UI redesign R1 revision 2 §1.2).
    void preferences.accent
    return {
      surface: token('--ds-surface', dark ? '#111317' : '#ffffff'),
      text: token('--ds-fg-muted', dark ? '#a1a7b3' : '#4b5563'),
      muted: token('--ds-fg-subtle', dark ? '#8a919c' : '#626975'),
      grid: token('--ds-muted', dark ? '#23272f' : '#e9ebef'),
      palette: [
        token('--ds-accent', dark ? '#2fbf7f' : '#047a4d'),
        token('--ds-info', dark ? '#7ab0ff' : '#1c64c8'),
        token('--ds-warning', dark ? '#ffb45c' : '#a34a00'),
        token('--ds-danger', dark ? '#ff6b5f' : '#c9241a'),
        token('--ds-fg-subtle', dark ? '#8a919c' : '#626975'),
        token('--ds-v-boolean', dark ? '#c8a6ff' : '#8a3fd1'),
      ],
    }
  })
}
