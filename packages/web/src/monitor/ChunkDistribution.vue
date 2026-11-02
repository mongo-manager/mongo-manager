<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ShardingView } from '@mongo-manager/shared/browser'

/**
 * W3.2: how each sharded collection's chunks lie across the shards — one stacked bar per
 * collection, a colour per shard (the same shard the same colour everywhere), its counts in words
 * for screen readers and in the legend.
 */
const props = defineProps<{ view: ShardingView }>()
const { t, locale } = useI18n()
/** The charts' palette (charts/theme.ts), by shard order. */
const SLOTS = ['bg-accent', 'bg-info', 'bg-warning', 'bg-danger', 'bg-fg-subtle', 'bg-v-boolean']
const shards = computed(() => {
  const ids = props.view.shards.map((s) => s.id)
  for (const c of props.view.collections)
    for (const s of Object.keys(c.chunks)) if (!ids.includes(s)) ids.push(s)
  return ids
})
const colour = (shard: string) => SLOTS[shards.value.indexOf(shard) % SLOTS.length]!
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0)
const rows = computed(() =>
  props.view.collections.map((c) => {
    const total = Object.values(c.chunks).reduce((a, b) => a + b, 0)
    return {
      ns: c.ns,
      total,
      parts: shards.value
        .map((s) => ({ shard: s, n: c.chunks[s] ?? 0 }))
        .filter((p) => p.n > 0)
        .map((p) => ({ ...p, pct: pct(p.n, total) })),
      imbalance: c.imbalance,
    }
  }),
)
const fmt = (n: number) => new Intl.NumberFormat(locale.value).format(n)
</script>

<template>
  <div class="flex flex-col gap-3" data-chunk-distribution>
    <ul class="flex flex-wrap gap-x-4 gap-y-1" :aria-label="t('shardingAdmin.distribution.legend')">
      <li v-for="s in shards" :key="s" class="flex items-center gap-1.5 text-small text-fg-muted">
        <span class="size-2.5 rounded-sm" :class="colour(s)" aria-hidden="true" />
        <span class="font-mono">{{ s }}</span>
      </li>
    </ul>
    <p v-if="!rows.length" class="text-small text-fg-subtle">{{ t('sharding.noCollections') }}</p>
    <ul class="flex flex-col gap-2.5">
      <li v-for="r in rows" :key="r.ns" class="flex flex-col gap-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="min-w-0 truncate font-mono text-small text-fg" :title="r.ns">{{ r.ns }}</span>
          <span class="shrink-0 text-small text-fg-subtle tabular-nums">{{
            t('shardingAdmin.distribution.total', { n: fmt(r.total) })
          }}</span>
        </div>
        <div
          class="flex h-2.5 w-full overflow-hidden rounded-full bg-subtle"
          role="img"
          :aria-label="
            t('shardingAdmin.distribution.bar', {
              ns: r.ns,
              parts: r.parts
                .map((p) => t('shardingAdmin.distribution.part', { shard: p.shard, n: fmt(p.n), pct: p.pct }))
                .join(', '),
            })
          "
        >
          <span
            v-for="p in r.parts"
            :key="p.shard"
            class="h-full border-r border-surface last:border-r-0"
            :class="colour(p.shard)"
            :style="{ width: `${p.pct}%` }"
            :title="t('shardingAdmin.distribution.part', { shard: p.shard, n: fmt(p.n), pct: p.pct })"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
