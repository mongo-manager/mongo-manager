import { inject, type ComputedRef, type InjectionKey } from 'vue'
import type { Widget, WidgetSize } from '@mongo-manager/shared/browser'

/**
 * User review 2026-10-09: what a widget's frame knows of the dashboard it is on — the widget, whether
 * the dashboard is being edited, where it stands, and what may be done to it. A module used outside a
 * dashboard has none of it, and its frame is a plain card.
 */
export interface WidgetContext {
  widget: Widget
  /** The widget's title, in the reader's language. */
  title: string
  editing: boolean
  position: number
  count: number
  /** Whether the widget has settings of its own. */
  configurable: boolean
  /** The drag handle's bindings (edit mode): draggable, drag and key handlers, pressed state. */
  handle: Record<string, unknown> | null
  remove(): void
  resize(size: WidgetSize): void
  move(delta: -1 | 1): void
  /** Where it starts on the wide grid (a column 1–12), or none: right after the one before it. */
  setColumn(col: number | null): void
  configure(): void
  setCollapsed(value: boolean): void
}

export const WIDGET_CONTEXT: InjectionKey<ComputedRef<WidgetContext>> = Symbol('widget')

export const useWidget = (): ComputedRef<WidgetContext> | null => inject(WIDGET_CONTEXT, null)
