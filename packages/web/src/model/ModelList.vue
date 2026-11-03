<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, ChevronRight, Lock } from 'lucide-vue-next'
import type { DataModel, ModelReference } from '@mongo-manager/shared/browser'
import { referenceWords } from './words'

/**
 * completion W6.4: the data model as a list, the keyboard's way through it. Each collection is a
 * button (↑ ↓ Home End move between them) that opens its fields and links; a link moves the focus to
 * the collection it points to, opened.
 */
const props = defineProps<{ model: DataModel; selected: string | null }>()
const emit = defineEmits<{ select: [name: string | null] }>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const open = ref(new Set<string>(props.selected ? [props.selected] : []))
const words = referenceWords(t)

const sorted = computed(() => [...props.model.collections].sort((a, b) => a.name.localeCompare(b.name)))
const out = (name: string) => props.model.references.filter((r) => r.from === name)
const into = (name: string) => props.model.references.filter((r) => r.to === name && r.from !== name)
const views = (name: string) => props.model.collections.filter((c) => c.viewOn === name)

const heads = () => [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-collection-head]') ?? [])]
function toggle(name: string): void {
  const next = new Set(open.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  open.value = next
  emit('select', next.has(name) ? name : null)
}
async function go(name: string): Promise<void> {
  open.value = new Set([...open.value, name])
  emit('select', name)
  await nextTick()
  heads()
    .find((h) => h.dataset.collectionHead === name)
    ?.focus()
}
function onKeydown(e: KeyboardEvent): void {
  const list = heads()
  const at = list.indexOf(e.target as HTMLButtonElement)
  if (at < 0) return
  const to =
    e.key === 'ArrowDown'
      ? at + 1
      : e.key === 'ArrowUp'
        ? at - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : null
  if (to === null) return
  e.preventDefault()
  list[Math.max(0, Math.min(list.length - 1, to))]?.focus()
}
const linkText = (r: ModelReference, outward: boolean) =>
  outward ? `${r.field} → ${r.to}.${r.toField}` : `${r.from}.${r.field} → ${r.toField}`
</script>

<template>
  <ul
    ref="root"
    data-model-list
    class="flex flex-col divide-y divide-line rounded-lg border border-line"
    @keydown="onKeydown"
  >
    <li v-for="c in sorted" :key="c.name" :data-collection="c.name">
      <h3>
        <button
          type="button"
          :data-collection-head="c.name"
          :aria-expanded="open.has(c.name)"
          class="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 text-left text-ui hover:bg-subtle focus-visible:-outline-offset-2"
          :class="selected === c.name ? 'bg-accent-soft/40' : ''"
          @click="toggle(c.name)"
        >
          <ChevronRight
            class="size-4 shrink-0 text-fg-subtle transition-transform duration-120"
            :class="open.has(c.name) ? 'rotate-90' : ''"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate font-medium text-fg">{{ c.name }}</span>
          <span class="shrink-0 text-small text-fg-subtle">
            {{
              c.type === 'view'
                ? t('model.viewOn', { coll: c.viewOn ?? '?' })
                : c.refused
                  ? t(`model.refused.${c.refused}`)
                  : t(
                      'model.fieldsCount',
                      { n: c.fields.length + c.moreFields },
                      c.fields.length + c.moreFields,
                    )
            }}
          </span>
        </button>
      </h3>
      <div v-if="open.has(c.name)" class="flex flex-col gap-3 px-3 pt-1 pb-3 pl-9">
        <ul
          v-if="c.fields.length"
          class="flex flex-col gap-0.5"
          :aria-label="t('model.fieldsOf', { coll: c.name })"
        >
          <li v-for="f in c.fields" :key="f.path" class="flex items-center gap-2 text-small">
            <code class="min-w-0 truncate text-fg">{{ f.path }}</code>
            <span v-if="f.masked" class="inline-flex items-center gap-1 text-fg-subtle">
              <Lock class="size-3" aria-hidden="true" />{{ t('model.hiddenFromYou') }}
            </span>
            <span v-else class="text-fg-subtle">
              {{ f.types.join(', ') }}<template v-if="f.items?.length"> ({{ f.items.join(', ') }})</template>
            </span>
          </li>
          <li v-if="c.moreFields > 0" class="text-small text-fg-subtle">
            {{ t('model.more', { n: c.moreFields }) }}
          </li>
        </ul>
        <div
          v-if="out(c.name).length || into(c.name).length || views(c.name).length || c.viewOn"
          class="flex flex-col gap-1"
        >
          <p class="text-small font-medium text-fg-muted">{{ t('model.links') }}</p>
          <ul class="flex flex-col gap-1">
            <li v-for="r in out(c.name)" :key="`o${r.field}${r.to}${r.toField}`" class="text-small">
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1.5 rounded text-accent-fg hover:underline"
                @click="go(r.to)"
              >
                <ArrowRight class="size-3.5" aria-hidden="true" /><code>{{ linkText(r, true) }}</code>
              </button>
              <span class="ml-2 text-fg-subtle">{{ words(r) }}</span>
            </li>
            <li v-for="r in into(c.name)" :key="`i${r.from}${r.field}${r.toField}`" class="text-small">
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1.5 rounded text-accent-fg hover:underline"
                @click="go(r.from)"
              >
                <ArrowRight class="size-3.5 rotate-180" aria-hidden="true" /><code>{{
                  linkText(r, false)
                }}</code>
              </button>
              <span class="ml-2 text-fg-subtle">{{ words(r) }}</span>
            </li>
            <li v-if="c.viewOn" class="text-small">
              <button
                type="button"
                class="cursor-pointer rounded text-accent-fg hover:underline"
                @click="go(c.viewOn)"
              >
                {{ t('model.viewOn', { coll: c.viewOn }) }}
              </button>
            </li>
            <li v-for="v in views(c.name)" :key="`v${v.name}`" class="text-small">
              <button
                type="button"
                class="cursor-pointer rounded text-accent-fg hover:underline"
                @click="go(v.name)"
              >
                {{ t('model.viewedBy', { view: v.name }) }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </li>
  </ul>
</template>
