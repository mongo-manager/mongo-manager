<script setup lang="ts">
import { computed, h, ref, useSlots, type VNode } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import { isHiddenAt } from '@mongo-manager/shared/browser'
import { parseMarkdown, type Block, type Inline } from './markdown'

/**
 * Security audit 2026-10-16 (M2): a code block's characters that hide, reverse or show as nothing
 * (a direction override reordering what is shown, a zero-width space inside a name), as `[U+…]` —
 * shown and copied so, never run unseen. Line breaks and tabs are code's own, and an emoji's joiner
 * and selector inside an emoji hide nothing (review of the security pass).
 */
const revealed = (text: string) =>
  [...text]
    .map((c, i, all) =>
      c !== '\n' && c !== '\t' && c !== '\r' && isHiddenAt(all, i)
        ? `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`
        : c,
    )
    .join('')

/**
 * Phase 4a-1 spec §1.4, S5: an answer drawn as VNodes from a Markdown subset — text nodes only
 * (Vue escapes them), no images, no links, no HTML: nothing in an answer makes the browser load anything.
 */
const props = defineProps<{
  source: string
  /** Headings as real ones (a plugin's README: its outline); a chat answer keeps them as text. */
  headingTag?: 'h4' | 'h5'
}>()
const { t } = useI18n()
const blocks = computed(() => parseMarkdown(props.source))
const copied = ref<number | null>(null)

const failed = ref<number | null>(null)
async function copy(text: string, index: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Final review minor 10: a refused clipboard (permissions, an insecure page) says so.
    failed.value = index
    setTimeout(() => {
      if (failed.value === index) failed.value = null
    }, 2500)
    return
  }
  failed.value = null
  copied.value = index
  setTimeout(() => {
    if (copied.value === index) copied.value = null
  }, 1500)
}

function inline(nodes: Inline[]): Array<VNode | string> {
  return nodes.map((n) => {
    if (n.kind === 'text') return n.text
    if (n.kind === 'code')
      return h('code', { class: 'rounded bg-subtle px-1 py-0.5 font-mono text-[0.85em]' }, n.text)
    return h(n.kind === 'strong' ? 'strong' : 'em', inline(n.children))
  })
}

const slots = useSlots()

/** `code` counts code blocks: the panel's actions hang under the one the server parsed (4a-2 plan ruling 6). */
function block(b: Block, index: number, code: number): VNode {
  switch (b.kind) {
    case 'p':
      return h('p', inline(b.children))
    case 'heading':
      return h(props.headingTag ?? 'p', { class: 'font-semibold text-fg' }, inline(b.children))
    case 'list':
      return h(
        b.ordered ? 'ol' : 'ul',
        { class: b.ordered ? 'list-decimal pl-5' : 'list-disc pl-5' },
        b.items.map((item) => h('li', inline(item))),
      )
    case 'codeBlock': {
      const shown = revealed(b.text)
      return h('div', { class: 'flex flex-col gap-2', 'data-code-block': '' }, [
        // A header bar holds the language and Copy, so the button never covers the code (4a-2 UI review).
        h(
          'div',
          {
            class: 'overflow-hidden rounded-lg border border-line bg-subtle',
          },
          [
            h(
              'div',
              {
                class:
                  'flex items-center justify-between gap-2 border-b border-line px-3 py-1 text-xs text-fg-subtle',
              },
              [
                h('span', { class: 'font-mono' }, b.lang || 'code'),
                h(
                  'button',
                  {
                    type: 'button',
                    class:
                      'inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted transition-colors duration-150 hover:bg-muted/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                    onClick: () => void copy(shown, index),
                  },
                  [
                    h(copied.value === index ? Check : Copy, { class: 'size-3.5', 'aria-hidden': 'true' }),
                    failed.value === index
                      ? t('ai.copyFailed')
                      : copied.value === index
                        ? t('ai.copied')
                        : t('ai.copy'),
                  ],
                ),
              ],
            ),
            h(
              'pre',
              {
                class: 'overflow-x-auto p-3 font-mono text-xs leading-relaxed text-fg',
              },
              shown,
            ),
          ],
        ),
        shown !== b.text
          ? h(
              'p',
              {
                role: 'note',
                class: 'rounded-lg bg-warning-soft px-3 py-2 text-small text-warning',
                'data-hidden-chars': '',
              },
              t('ai.hiddenChars'),
            )
          : null,
        ...(slots.block?.({ index: code }) ?? []),
      ])
    }
  }
}

const Rendered = () => {
  let code = 0
  return h(
    'div',
    { class: 'flex flex-col gap-3' },
    blocks.value.map((b, i) => block(b, i, b.kind === 'codeBlock' ? code++ : -1)),
  )
}
</script>

<template>
  <div class="text-ui leading-relaxed text-fg"><Rendered /></div>
</template>
