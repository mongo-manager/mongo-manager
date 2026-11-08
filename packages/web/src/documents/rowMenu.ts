// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Clipboard, CopyPlus, ListFilter, Pencil, SquareArrowOutUpRight, Trash2 } from 'lucide-vue-next'
import type { DsMenuItem } from '@/ds/menu'
import { hasId, type Row } from './rows'
import { decodeValue, idLabel } from './values'

/** How much of a value the filter item names (a long one would make the menu very wide). */
const FILTER_LABEL = 40
const cut = (text: string): string => (text.length > FILTER_LABEL ? `${text.slice(0, FILTER_LABEL)}…` : text)

/** What a right click on a cell adds before the row's actions (document page design §6.10). */
export interface CellContext {
  field: string
  /** The value as the filter chip writes it (shell), or null when it cannot be filtered by. */
  filter: string | null
}

/**
 * The same row actions in every view; writes only when allowed; `extras` after them (plugins'). With
 * `cell` (a right click on one), its own come first: copy its value, filter by it.
 */
export function rowMenuItems(
  row: Row,
  canWrite: boolean,
  t: (key: string, values?: Record<string, unknown>) => string,
  extras: readonly DsMenuItem[] = [],
  cell?: CellContext,
): DsMenuItem[] {
  // Without a readable _id a delete could hit another document (e.g. one whose _id really is null).
  if (row.kind === 'unsupported')
    return canWrite && row.rawId !== null && row.rawId !== undefined
      ? [{ id: 'delete', label: t('documents.delete'), icon: Trash2, danger: true }]
      : []
  // Reviewer B I3: without an _id there is nothing to name the document by to edit or delete it.
  const named = hasId(row)
  const own: DsMenuItem[] = cell
    ? [
        { id: 'copyValue', label: t('documents.copyValue', { field: cell.field }), icon: Clipboard },
        ...(cell.filter !== null
          ? [
              {
                id: 'filterBy',
                label: t('documents.filterBy', { field: cell.field, value: cut(cell.filter) }),
                icon: ListFilter,
              },
            ]
          : []),
      ]
    : []
  return [
    ...own,
    { id: 'inspect', label: t('documents.inspect'), icon: SquareArrowOutUpRight, separator: own.length > 0 },
    ...(canWrite && named ? [{ id: 'edit', label: t('documents.edit'), icon: Pencil }] : []),
    ...(canWrite ? [{ id: 'clone', label: t('documents.clone'), icon: CopyPlus }] : []),
    { id: 'copy', label: t('documents.copy'), icon: Clipboard },
    ...(canWrite && named
      ? [{ id: 'delete', label: t('documents.delete'), icon: Trash2, danger: true }]
      : []),
    // A plugin's action opens it with this document: one that has an _id to name it by.
    ...(named ? extras.map((e, i) => (i === 0 ? { ...e, separator: true } : e)) : []),
  ]
}

export const rowId = (row: Row): string => {
  // An aggregation's output may have no _id: it is named by its place in the results (#1, #2…).
  if (row.kind === 'document' && !('_id' in row.value)) return `#${Number(row.key.split(':')[0]) + 1}`
  return idLabel(row.kind === 'document' ? row.value._id : decodeValue(row.rawId))
}
