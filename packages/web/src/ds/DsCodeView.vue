<script setup lang="ts">
import { computed } from 'vue'
import { Lock } from 'lucide-vue-next'
import { tokenize, type Token } from './code/tokenize'
import { TOKEN_CLASSES } from './code/tokenClasses'

const props = defineProps<{
  text: string
  /**
   * W5: a string token that stands for a hidden value. It is shown as "***" with a lock and the
   * label (a tooltip and screen-reader text), as the table shows a hidden cell.
   */
  hidden?: { token: string; label: string }
}>()
const HIGHLIGHT_LIMIT = 100_000
/**
 * Past the limit the text is shown plain; a hidden value is still cut out of it as its own token, so
 * it shows as *** with its lock, never as the mark that stands for it (review I5).
 */
function plain(text: string): Token[] {
  const mark = props.hidden?.token
  if (!mark || !text.includes(mark)) return [{ type: 'text', text }]
  return text
    .split(mark)
    .flatMap((part, i): Token[] => [
      ...(i > 0 ? [{ type: 'string' as const, text: mark }] : []),
      ...(part ? [{ type: 'text' as const, text: part }] : []),
    ])
}
const tokens = computed<Token[]>(() =>
  props.text.length > HIGHLIGHT_LIMIT ? plain(props.text) : tokenize(props.text),
)
/** What a hidden value reads as: the server's mask, quoted as the string it is. */
const SHOWN = JSON.stringify('***')
const isHidden = (token: Token) => token.type === 'string' && token.text === props.hidden?.token
</script>

<template>
  <pre class="m-0 font-mono text-small leading-5 break-words whitespace-pre-wrap"><template
    v-for="(token, i) in tokens"
    :key="i"
  ><span
    v-if="isHidden(token)"
    data-masked
    class="inline-flex items-center gap-0.5 text-fg-subtle"
    :title="hidden!.label"
  ><Lock class="size-3" aria-hidden="true" /><span aria-hidden="true">{{ SHOWN }}</span><span class="sr-only">{{
    hidden!.label
  }}</span></span><span v-else :class="TOKEN_CLASSES[token.type]">{{ token.text }}</span></template></pre>
</template>
