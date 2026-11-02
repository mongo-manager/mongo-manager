<script setup lang="ts">
import { pluginFrameKey, usePluginsStore } from './store'
import PluginFrame from './PluginFrame.vue'

/**
 * Phase 4b §3: one hidden frame per plugin that renders cells, its bridge kept in the store — loaded
 * again when its version or permissions change (security audit 2026-10-16, M3).
 */
const plugins = usePluginsStore()
</script>

<template>
  <PluginFrame
    v-for="p in plugins.cellPlugins"
    :key="pluginFrameKey(p)"
    :plugin="p"
    kind="cellRenderer"
    :contribution="p.contributes.cellRenderers[0]!.id"
    hidden
    @bridge="plugins.setRenderer(p.id, $event)"
  />
</template>
