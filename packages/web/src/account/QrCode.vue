<script setup lang="ts">
import { computed } from 'vue'
import QRCode from 'qrcode'

/** A QR code as one SVG path: no image data, no inline HTML, CSP-safe. */
const props = defineProps<{ value: string; label: string }>()
const MARGIN = 4
const qr = computed(() => {
  const { modules } = QRCode.create(props.value, { errorCorrectionLevel: 'M' })
  let d = ''
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`
    }
  }
  return { size: modules.size + MARGIN * 2, d }
})
</script>

<template>
  <svg
    role="img"
    :aria-label="label"
    :viewBox="`0 0 ${qr.size} ${qr.size}`"
    shape-rendering="crispEdges"
    class="size-48 shrink-0 rounded-lg"
  >
    <rect :width="qr.size" :height="qr.size" fill="#ffffff" />
    <path :d="qr.d" fill="#000000" />
  </svg>
</template>
