<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })
const attrs = useAttrs()
// A placeholder takes the shape of what it stands in for: its own rounding when it is given one (the
// default came later in the stylesheet and won), else a slight one.
// Read at each render: attrs are not reactive, and Vue hands the class over as one string.
const rounding = () => (/(^|\s)rounded(-|\s|$)/.test(String(attrs.class ?? '')) ? '' : 'rounded-md')
</script>

<template>
  <span
    v-bind="attrs"
    aria-hidden="true"
    class="block animate-[ds-shimmer_1.4s_linear_infinite] bg-[linear-gradient(90deg,var(--ds-subtle),var(--ds-muted),var(--ds-subtle))] bg-[length:200%_100%] motion-reduce:animate-none"
    :class="rounding()"
  />
</template>
