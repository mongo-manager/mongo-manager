// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Component } from 'vue'

/** UI redesign R1 spec §2: a menu entry (a superset of the old MenuItem, so existing lists fit). */
export interface DsMenuItem {
  id: string
  label: string
  icon?: Component
  danger?: boolean
  /** A count beside the label, and what it means for a screen reader. */
  badge?: { text: string; label: string }
  shortcut?: string[]
  /** A hairline above this item: it starts a new group. */
  separator?: boolean
  /** A muted second line. */
  hint?: string
  disabled?: boolean
}

/** A choice in a list (DsCombobox). */
export interface DsOption {
  value: string
  label: string
  hint?: string
  icon?: Component
}
