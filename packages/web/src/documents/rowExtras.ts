import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue'
import type { DsMenuItem } from '@/ds/menu'
/**
 * Phase 4b §3: actions a page adds to every document's menu (a plugin's "Show on map"), given by the
 * documents of a collection only — an aggregation's output or a change event has none.
 */
const KEY: InjectionKey<ComputedRef<DsMenuItem[]>> = Symbol('row-extras')
const NONE = computed<DsMenuItem[]>(() => [])

export const provideRowExtras = (items: ComputedRef<DsMenuItem[]>) => provide(KEY, items)
export const useRowExtras = (): ComputedRef<DsMenuItem[]> => inject(KEY, NONE)
