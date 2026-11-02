import { Clipboard, CopyPlus, PanelRight, Pencil, Trash2 } from 'lucide-vue-next'
import type { DsMenuItem } from '@/ds/menu'
import { hasId, type Row } from './rows'
import { decodeValue, idLabel } from './values'

/** The same row actions in every view; writes only when allowed; `extras` after them (plugins'). */
export function rowMenuItems(
  row: Row,
  canWrite: boolean,
  t: (key: string) => string,
  extras: readonly DsMenuItem[] = [],
): DsMenuItem[] {
  // Without a readable _id a delete could hit another document (e.g. one whose _id really is null).
  if (row.kind === 'unsupported')
    return canWrite && row.rawId !== null && row.rawId !== undefined
      ? [{ id: 'delete', label: t('documents.delete'), icon: Trash2, danger: true }]
      : []
  // Reviewer B I3: without an _id there is nothing to name the document by to edit or delete it.
  const named = hasId(row)
  return [
    { id: 'inspect', label: t('documents.inspect'), icon: PanelRight },
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
