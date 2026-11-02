<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import DsCodeView from './DsCodeView.vue'

/**
 * Highlighted code that is only built once it comes near the viewport: a page of 1000 documents
 * then costs 1000 plain placeholders instead of tens of thousands of highlighted spans.
 */
const props = defineProps<{ text: string; hidden?: { token: string; label: string } }>()
const host = ref<HTMLElement | null>(null)
const shown = ref(typeof IntersectionObserver === 'undefined')
let observer: IntersectionObserver | undefined

onMounted(() => {
  if (shown.value || !host.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        shown.value = true
        observer?.disconnect()
      }
    },
    { rootMargin: '400px 0px' },
  )
  observer.observe(host.value)
})
onBeforeUnmount(() => observer?.disconnect())

const lines = () => Math.min(40, props.text.split('\n').length)
</script>

<template>
  <div ref="host">
    <DsCodeView v-if="shown" :text="text" :hidden="hidden" />
    <div v-else aria-hidden="true" :style="{ height: `${lines() * 20}px` }" />
  </div>
</template>
