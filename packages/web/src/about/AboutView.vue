<script setup lang="ts">
import { useId, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUpRight,
  BanknoteX,
  BookOpen,
  Bug,
  CreativeCommons,
  EyeOff,
  FileText,
  Github,
  Info,
  Mail,
  Network,
  RefreshCcw,
  RefreshCwOff,
  ShieldCheck,
  UserRoundCheck,
  WifiOff,
} from 'lucide-vue-next'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import ProductMark from '@/workspace/ProductMark.vue'
import { openDocs } from '@/workspace/docs'
import { APP_VERSION } from '@/version'
import { AUTHOR, LICENSE, PROJECT_LINKS, shownUrl } from './project'

/**
 * User request 2026-10-31: the About page — the product and its version, its author, where the
 * project lives, its license in plain words and how it treats the network. Everything here is in
 * the bundle: the links point out, but the page itself loads nothing from another site.
 */
const { t, locale } = useI18n()
const ids = { author: useId(), project: useId(), license: useId(), privacy: useId() }
const initials = AUTHOR.name
  .split(/\s+/)
  .map((part) => part[0] ?? '')
  .join('')
  .slice(0, 2)
  .toLocaleUpperCase('en')
/** A name and a year read the same in every language. */
const copyright = `© 2025–2026 ${AUTHOR.name}`

interface LinkRow {
  id: string
  icon: Component
  label: string
  hint: string
  href: string
}
const authorLinks = (): LinkRow[] => [
  {
    id: 'email',
    icon: Mail,
    label: t('about.author.email'),
    hint: AUTHOR.email,
    href: `mailto:${AUTHOR.email}`,
  },
  {
    id: 'github',
    icon: Github,
    label: t('about.author.github'),
    hint: shownUrl(AUTHOR.github),
    href: AUTHOR.github,
  },
]
const projectLinks = (): LinkRow[] => [
  {
    id: 'repository',
    icon: Github,
    label: t('about.project.repository'),
    hint: t('about.project.repositoryHint'),
    href: PROJECT_LINKS.repository,
  },
  {
    id: 'issues',
    icon: Bug,
    label: t('about.project.issues'),
    hint: t('about.project.issuesHint'),
    href: PROJECT_LINKS.issues,
  },
  {
    id: 'security',
    icon: ShieldCheck,
    label: t('about.project.security'),
    hint: t('about.project.securityHint'),
    href: PROJECT_LINKS.security,
  },
]
const TERMS = [
  { id: 'attribution', icon: UserRoundCheck },
  { id: 'nonCommercial', icon: BanknoteX },
  { id: 'shareAlike', icon: RefreshCcw },
] as const
const PRIVACY = [
  { id: 'offline', icon: WifiOff },
  { id: 'telemetry', icon: EyeOff },
  { id: 'updates', icon: RefreshCwOff },
  { id: 'reach', icon: Network },
] as const

const card = 'min-w-0 rounded-card border border-line bg-surface p-5 shadow-xs'
const cardTitle = 'mb-3 text-ui font-semibold text-fg'
const tile = 'grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted'
const row =
  'group -mx-2 flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-120 hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus'
const textLink =
  'inline-flex min-w-0 items-center gap-1 rounded-sm text-ui text-accent-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus'
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-about-page>
    <DsPageHeader :title="t('tabs.about')" :icon="Info" />
    <div class="relative min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
        <!-- The product, its version and its terms in a glance. -->
        <div
          class="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-card border border-line bg-gradient-to-br from-accent-soft to-surface p-6 shadow-xs"
        >
          <ProductMark :size="64" />
          <div class="min-w-0 flex-1 basis-60">
            <h3 class="text-title-l font-semibold text-fg">{{ t('app.name') }}</h3>
            <p class="mt-0.5 text-ui text-fg-muted">{{ t('about.tagline') }}</p>
            <div class="mt-3 flex flex-wrap items-center gap-1.5">
              <DsBadge tone="accent" data-about-version>{{
                t('about.version', { version: APP_VERSION })
              }}</DsBadge>
              <DsBadge tone="success">{{ t('about.free') }}</DsBadge>
              <DsBadge
                ><span class="font-mono">{{ LICENSE.short }}</span></DsBadge
              >
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <a
              data-about-github
              :href="PROJECT_LINKS.repository"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-ui font-medium whitespace-nowrap text-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] transition-colors duration-120 hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              ><Github class="size-4" aria-hidden="true" />{{ t('about.project.github')
              }}<span class="sr-only"> {{ t('about.newTab') }}</span></a
            >
            <DsButton :icon="BookOpen" @click="openDocs(locale)">{{ t('header.docs') }}</DsButton>
          </div>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <section :class="card" :aria-labelledby="ids.author" data-about-author>
            <h3 :id="ids.author" :class="cardTitle">{{ t('about.author.title') }}</h3>
            <div class="flex min-w-0 items-center gap-3">
              <span
                class="grid size-12 shrink-0 place-items-center rounded-full bg-accent-soft text-title-s font-semibold text-accent-fg"
                aria-hidden="true"
                >{{ initials }}</span
              >
              <div class="min-w-0">
                <p class="truncate text-title-s font-semibold text-fg">{{ AUTHOR.name }}</p>
                <p class="text-small text-fg-muted">{{ t('about.author.role') }}</p>
              </div>
            </div>
            <ul class="mt-3 flex flex-col">
              <li v-for="link in authorLinks()" :key="link.id">
                <!-- A mailto: link opens in a new tab too: a web mail that handles it would replace the app. -->
                <a
                  :data-about-link="link.id"
                  :href="link.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  :class="row"
                >
                  <span :class="tile" aria-hidden="true"><component :is="link.icon" class="size-4" /></span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-small text-fg-subtle">{{ link.label }}</span>
                    <span class="truncate text-ui text-fg">{{ link.hint }}</span>
                  </span>
                  <ArrowUpRight
                    class="size-4 shrink-0 text-fg-subtle transition-colors duration-120 group-hover:text-fg"
                    aria-hidden="true"
                  />
                  <span class="sr-only">{{ t('about.newTab') }}</span>
                </a>
              </li>
            </ul>
          </section>

          <section :class="card" :aria-labelledby="ids.project" data-about-project>
            <h3 :id="ids.project" :class="cardTitle">{{ t('about.project.title') }}</h3>
            <ul class="flex flex-col">
              <li v-for="link in projectLinks()" :key="link.id">
                <a
                  :data-about-link="link.id"
                  :href="link.href"
                  :title="shownUrl(link.href)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :class="row"
                >
                  <span :class="tile" aria-hidden="true"><component :is="link.icon" class="size-4" /></span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-ui font-medium text-fg">{{ link.label }}</span>
                    <span class="text-small text-fg-muted">{{ link.hint }}</span>
                  </span>
                  <ArrowUpRight
                    class="size-4 shrink-0 text-fg-subtle transition-colors duration-120 group-hover:text-fg"
                    aria-hidden="true"
                  />
                  <span class="sr-only">{{ t('about.newTab') }}</span>
                </a>
              </li>
            </ul>
          </section>
        </div>

        <section :class="card" :aria-labelledby="ids.license" data-about-license>
          <div class="mb-3 flex flex-wrap items-start gap-3">
            <span
              class="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
              aria-hidden="true"
              ><CreativeCommons class="size-[18px]"
            /></span>
            <div class="min-w-0 flex-1 basis-60">
              <h3 :id="ids.license" class="text-ui font-semibold text-fg">{{ t('about.license.title') }}</h3>
              <p class="text-ui text-fg-muted" data-about-license-name>{{ LICENSE.name }}</p>
            </div>
            <DsBadge tone="accent"
              ><span class="font-mono">{{ LICENSE.short }}</span></DsBadge
            >
          </div>
          <p class="text-ui text-fg">{{ t('about.license.summary') }}</p>
          <ul class="mt-3 grid gap-3 sm:grid-cols-3">
            <li
              v-for="term in TERMS"
              :key="term.id"
              :data-about-term="term.id"
              class="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-canvas p-3.5"
            >
              <span class="flex items-center gap-2 text-ui font-semibold text-fg">
                <component :is="term.icon" class="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
                {{ t(`about.license.${term.id}`) }}
              </span>
              <span class="text-small text-fg-muted">{{ t(`about.license.${term.id}Text`) }}</span>
            </li>
          </ul>
          <div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
            <a
              data-about-link="deed"
              :href="LICENSE.deed"
              target="_blank"
              rel="noopener noreferrer"
              :class="textLink"
              ><CreativeCommons class="size-3.5 shrink-0" aria-hidden="true" />{{ t('about.license.deed')
              }}<ArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" /><span class="sr-only">
                {{ t('about.newTab') }}</span
              ></a
            >
            <a
              data-about-link="license"
              :href="PROJECT_LINKS.license"
              target="_blank"
              rel="noopener noreferrer"
              :class="textLink"
              ><FileText class="size-3.5 shrink-0" aria-hidden="true" />{{ t('about.license.text')
              }}<ArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" /><span class="sr-only">
                {{ t('about.newTab') }}</span
              ></a
            >
          </div>
          <p class="mt-3 border-t border-line pt-3 text-small text-fg-subtle">
            {{ t('about.license.thirdParty') }}
          </p>
        </section>

        <section :class="card" :aria-labelledby="ids.privacy" data-about-privacy>
          <h3 :id="ids.privacy" :class="cardTitle">{{ t('about.privacy.title') }}</h3>
          <ul class="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            <li v-for="item in PRIVACY" :key="item.id" class="flex min-w-0 items-start gap-3">
              <span :class="tile" aria-hidden="true"><component :is="item.icon" class="size-4" /></span>
              <span class="flex min-w-0 flex-col">
                <span class="text-ui font-medium text-fg">{{ t(`about.privacy.${item.id}`) }}</span>
                <span class="text-small text-fg-muted">{{ t(`about.privacy.${item.id}Text`) }}</span>
              </span>
            </li>
          </ul>
        </section>

        <p class="pb-2 text-center text-small text-fg-subtle">{{ copyright }}</p>
      </div>
    </div>
  </section>
</template>
