<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import DsSuggestInput from '@/ds/DsSuggestInput.vue'
import { useCollectionNames, useDatabaseNames, useNamespaceNames } from './namespaceNames'

/**
 * User report 2026-10-30: a database's or a collection's name for a connection, its own names
 * offered (a collection's: those of `db`) — one field, so a list of rows can each have theirs.
 */
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    label: string
    connectionId: string | null | undefined
    /** `namespace`: a database or `db.collection` (a filter's). */
    kind: 'database' | 'collection' | 'namespace'
    /** The database whose collections are offered (kind collection). */
    db?: string
    /** Views offered too (a filter on any namespace); off where only a collection will do. */
    views?: boolean
  }>(),
  { db: '', views: false },
)
const model = defineModel<string>({ required: true })
const databases = useDatabaseNames(() => (props.kind === 'database' ? props.connectionId : null))
const collections = useCollectionNames(
  () => (props.kind === 'collection' ? props.connectionId : null),
  () => props.db,
  { views: props.views },
)
const namespaces = useNamespaceNames(
  () => (props.kind === 'namespace' ? props.connectionId : null),
  () => model.value,
)
</script>

<template>
  <DsSuggestInput
    v-model="model"
    v-bind="$attrs"
    :label="label"
    :suggestions="kind === 'database' ? databases : kind === 'collection' ? collections : namespaces"
  />
</template>
