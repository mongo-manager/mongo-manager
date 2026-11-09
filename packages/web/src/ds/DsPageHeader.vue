<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import type { Component } from 'vue'

/**
 * UI redesign R2–R5 spec §2: the header every page and tab shares — R1's collection header made
 * general. An icon tile, the title (with badges after it), a line of facts separated by "·", the
 * page's actions on the right (one primary, the rest in a "…" menu), and its section tabs below.
 */
withDefaults(
  defineProps<{
    title: string
    icon?: Component
    /** A word before the facts, in mono (the database a collection is in, a host). */
    context?: string
    facts?: readonly string[]
    /** The heading level: a tab's header is inside the workspace's own heading. */
    level?: 1 | 2
    /** The title's full name, when it is shortened on screen. */
    fullTitle?: string
    /** The context's full value on hover (an address too long for the line). */
    contextTitle?: string
    /** What a page is for, under its title and facts (a tab, which shows facts, leaves it out). */
    description?: string
  }>(),
  {
    icon: undefined,
    context: undefined,
    facts: () => [],
    level: 2,
    fullTitle: undefined,
    contextTitle: undefined,
    description: undefined,
  },
)
</script>

<template>
  <header class="shrink-0 border-b border-line px-4 pt-3" :class="$slots.tabs ? '' : 'pb-3'">
    <div v-if="$slots.crumbs" class="mb-1.5 flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
      <slot name="crumbs" />
    </div>
    <!-- Review of R3–R5 (I-2): when the line is too narrow the actions go under the title. -->
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <slot name="icon">
        <span
          v-if="icon"
          class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <component :is="icon" class="size-[18px]" />
        </span>
      </slot>
      <div class="min-w-0 flex-1 basis-56">
        <component
          :is="level === 1 ? 'h1' : 'h2'"
          class="flex min-w-0 items-center gap-2 text-title-m font-semibold text-fg"
        >
          <span class="truncate" :title="fullTitle ?? title"
            ><slot name="title">{{ title }}</slot></span
          >
          <slot name="badges" />
        </component>
        <p
          v-if="context || facts.length > 0 || $slots.facts"
          class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-fg-subtle"
        >
          <span v-if="context" class="truncate font-mono" :title="contextTitle">{{ context }}</span>
          <template v-for="(fact, i) in facts" :key="`${i}-${fact}`">
            <span v-if="context || i > 0" aria-hidden="true">·</span>
            <span class="tabular-nums">{{ fact }}</span>
          </template>
          <slot name="facts" />
        </p>
        <p v-if="description" class="mt-0.5 max-w-3xl text-small text-fg-muted">{{ description }}</p>
      </div>
      <div
        v-if="$slots.actions"
        class="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1.5"
      >
        <slot name="actions" />
      </div>
    </div>
    <div v-if="$slots.tabs" class="mt-1.5 -mb-px">
      <slot name="tabs" />
    </div>
  </header>
</template>
