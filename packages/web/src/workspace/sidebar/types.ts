import type { Component } from 'vue'

/** UI redesign R1 revision 2 §3.1: one entry of a sidebar group. */
export interface SidebarEntry {
  id: string
  label: string
  icon: Component
  active?: boolean
  badge?: number
  badgeLabel?: string
}
