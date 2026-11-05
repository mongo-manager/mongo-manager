<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Lock, TriangleAlert } from 'lucide-vue-next'
import {
  FIELD_TYPES,
  type ConvertedSample,
  type MappingEntry,
  type TransferPreviewResponse,
} from '@mongo-manager/shared/browser'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * Phase 3d-1 spec §5.3, §9: one row per field of the file — where it goes, as which type, and what an
 * empty or unconvertible value becomes. Personal paths are locked; the server checks them again.
 */
const props = defineProps<{
  fields: TransferPreviewResponse['fields']
  /** Whether a target path is hidden from this user (a personal field). */
  locked: (path: string) => boolean
  /** W4.1: each field's samples as the import would write them, by source (absent while loading). */
  converted?: Record<string, ConvertedSample[]>
}>()
const conversions = (entry: MappingEntry): ConvertedSample[] =>
  entry.include && entry.type !== 'keep' ? (props.converted?.[entry.source] ?? []).slice(0, 3) : []
const rawSample = (source: string, i: number) =>
  props.fields.find((f) => f.source === source)?.samples[i] ?? ''
const model = defineModel<MappingEntry[]>({ required: true })
const { t } = useI18n()
const unusual = (source: string) => props.fields.find((f) => f.source === source)?.unusual ?? false
const samples = (source: string) =>
  props.fields
    .find((f) => f.source === source)
    ?.samples.slice(0, 2)
    .join(' · ') ?? ''
const control = 'h-8 rounded-md border border-line-strong bg-surface px-2 text-sm'
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full min-w-[40rem] text-ui">
      <thead>
        <tr class="text-left text-small text-fg-subtle">
          <th class="p-2 font-medium">{{ t('dataTransfer.mapping.field') }}</th>
          <th class="p-2 font-medium">{{ t('dataTransfer.mapping.target') }}</th>
          <th class="p-2 font-medium">{{ t('dataTransfer.mapping.type') }}</th>
          <th class="p-2 font-medium">{{ t('dataTransfer.mapping.empty') }}</th>
          <th class="p-2 font-medium">{{ t('dataTransfer.mapping.onError') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(entry, i) in model"
          :key="entry.source"
          :data-mapping-row="entry.source"
          class="border-t border-line align-top"
          :class="entry.include ? '' : 'opacity-60'"
        >
          <td class="p-2">
            <label class="flex items-center gap-2">
              <input
                v-model="model[i]!.include"
                type="checkbox"
                class="size-4 cursor-pointer accent-accent"
                :disabled="locked(entry.path)"
                :aria-label="t('dataTransfer.mapping.include', { field: entry.source })"
              />
              <span class="font-mono break-all">{{ entry.source }}</span>
              <Lock
                v-if="locked(entry.path)"
                class="size-3.5 shrink-0 text-warning"
                :aria-label="t('dataTransfer.personalLocked')"
              />
              <TriangleAlert
                v-else-if="unusual(entry.source)"
                class="size-3.5 shrink-0 text-warning"
                :aria-label="t('dataTransfer.mapping.unusual')"
              />
            </label>
            <p class="truncate pl-6 text-small text-fg-subtle">{{ samples(entry.source) }}</p>
            <ul
              v-if="conversions(entry).length"
              class="pl-6 font-mono text-small"
              :aria-label="t('dataTransfer.mapping.convertedFor', { field: entry.source })"
            >
              <li
                v-for="(c, j) in conversions(entry)"
                :key="j"
                class="truncate"
                :class="c.ok ? 'text-fg-muted' : 'text-warning'"
              >
                <template v-if="c.ok">{{
                  t('dataTransfer.mapping.convertedOk', { value: c.text, kind: c.kind })
                }}</template>
                <template v-else>{{
                  t('dataTransfer.mapping.convertedFail', {
                    value: rawSample(entry.source, j),
                    reason: c.reason,
                  })
                }}</template>
              </li>
            </ul>
          </td>
          <td class="p-2">
            <input
              v-model="model[i]!.path"
              :class="[control, 'w-full font-mono']"
              :aria-label="t('dataTransfer.mapping.targetFor', { field: entry.source })"
              :disabled="!entry.include"
            />
          </td>
          <td class="p-2">
            <DsSelect
              v-model="model[i]!.type"
              hide-label
              :label="t('dataTransfer.mapping.typeOf', { field: entry.source })"
              :disabled="!entry.include"
              :options="FIELD_TYPES.map((ty) => ({ value: ty, label: t(`dataTransfer.types.${ty}`) }))"
            />
          </td>
          <td class="p-2">
            <DsSelect
              v-model="model[i]!.empty"
              hide-label
              :label="t('dataTransfer.mapping.emptyFor', { field: entry.source })"
              :disabled="!entry.include"
              :options="
                (['skip', 'null', 'empty'] as const).map((v) => ({
                  value: v,
                  label: t(`dataTransfer.empty.${v}`),
                }))
              "
            />
          </td>
          <td class="p-2">
            <DsSelect
              v-model="model[i]!.onError"
              hide-label
              :label="t('dataTransfer.mapping.onErrorFor', { field: entry.source })"
              :disabled="!entry.include"
              :options="
                (['error', 'null', 'string'] as const).map((v) => ({
                  value: v,
                  label: t(`dataTransfer.onError.${v}`),
                }))
              "
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
