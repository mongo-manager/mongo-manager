<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { UploadCloud } from 'lucide-vue-next'

/** U4: a drop target that is also a keyboard button; any file goes (the server reads its magic bytes). */
const emit = defineEmits<{ file: [file: File] }>()
const { t } = useI18n()
const over = ref(false)
const input = ref<HTMLInputElement | null>(null)
const id = useId()
function take(files: FileList | File[] | null | undefined): void {
  const f = files?.[0]
  if (f) emit('file', f)
}
function onDrop(event: DragEvent): void {
  over.value = false
  take(event.dataTransfer?.files)
}
</script>

<template>
  <div
    data-test="drop-zone"
    role="button"
    tabindex="0"
    :aria-describedby="`${id}-f`"
    class="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-all duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    :class="
      over
        ? 'scale-[1.01] border-accent bg-accent-soft/70'
        : 'border-line-strong hover:border-accent hover:bg-subtle'
    "
    @click="input?.click()"
    @keydown.enter.prevent="input?.click()"
    @keydown.space.prevent="input?.click()"
    @dragenter.prevent="over = true"
    @dragover.prevent="over = true"
    @dragleave="over = false"
    @drop.prevent="onDrop"
  >
    <span
      class="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-fg transition-transform duration-150"
      :class="{ '-translate-y-0.5': over }"
    >
      <UploadCloud class="size-6" aria-hidden="true" />
    </span>
    <p class="font-medium text-fg">{{ t('backup.restore.drop') }}</p>
    <p class="text-ui text-fg-subtle">
      {{ t('backup.restore.or') }}
      <span class="font-medium text-accent-fg underline-offset-2 hover:underline">{{
        t('backup.restore.browse')
      }}</span>
    </p>
    <p :id="`${id}-f`" class="text-small text-fg-subtle">{{ t('backup.restore.formats') }}</p>
    <input
      ref="input"
      type="file"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      @change="take(($event.target as HTMLInputElement).files)"
    />
  </div>
</template>
