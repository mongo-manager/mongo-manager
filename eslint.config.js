// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'
import pluginVue from 'eslint-plugin-vue'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'

const webLocales = 'packages/web/src/i18n/locales/*.json'
const vmMessage = 'node:vm is not a security boundary (spec §5 S7)'

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    // Playwright's output: a trace being written keeps the pages' scripts there (2026-11-02).
    '**/test-results/**',
    '**/playwright-report/**',
    // Local dot-folders (tools, editors' copies of the repo): not the project's code.
    '.*/**',
    // Copy of the web build inside the CLI package.
    'packages/cli/public/**',
    // Phase 4b §4: the built plugins copied inside the CLI package.
    'packages/cli/plugins/**',
    // Generated mongosh runtime-support stub (rebuilt by scripts/build-shell-worker.mjs).
    '**/shell/worker/*.generated.cjs',
    '**/shell/catalogue.generated.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  pluginVue.configs['flat/recommended'],
  // Prettier owns formatting.
  pluginVue.configs['no-layout-rules'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], sourceType: 'module' },
    },
  },
  // vue-i18n rules only for the web app: its recommended config would otherwise parse every JSON/YAML file.
  ...vueI18n.configs['flat/recommended']
    .filter((c) => !c.name?.endsWith(':yaml'))
    .map((c) => ({ ...c, files: c.name?.endsWith(':json') ? [webLocales] : ['packages/web/**/*.vue'] })),
  {
    files: ['packages/web/**/*.{ts,vue}', webLocales],
    settings: { 'vue-i18n': { localeDir: `./${webLocales}`, messageSyntaxVersion: '^11.0.0' } },
  },
  // Languages (2026-10-29): French puts a narrow no-break space before ; : ! ? — in text, never in
  // code. The language files are checked by test/i18n-languages.test.ts instead (no hidden or
  // direction-changing character, only the spaces a language's typography uses).
  {
    // Review of the last four languages (minor 1): only the plugins keep French words in code.
    files: ['packages/plugins/**/*.{ts,js}'],
    rules: { 'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }] },
  },
  {
    files: [webLocales],
    rules: { 'no-irregular-whitespace': 'off' },
  },
  {
    // The main shared entry includes the server-only connection-string parser; the browser gets /browser.
    files: ['packages/web/src/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@mongo-manager/shared',
              message:
                "Import runtime values from '@mongo-manager/shared/browser'; only types may come from the main entry.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/web/**/*.vue'],
    rules: {
      'vue/no-v-html': 'error',
      'vue/multi-word-component-names': 'off',
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[-#:()&+×/°…·•→←↑↓⌘⇧⏎\\s\\d.,%|]+$' }],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      '@intlify/vue-i18n/no-html-messages': 'error',
      '@intlify/vue-i18n/no-dynamic-keys': 'off',
    },
  },
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: vmMessage },
            { name: 'node:vm', message: vmMessage },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Security review 2026-10-13 (ops): rules that need the types. A promise nobody awaits or catches
  // can fail unseen — a refused write, a check that never ran. The application's TypeScript only:
  // with types, Vue files take a quarter of an hour to lint.
  {
    files: ['packages/{server,shared,cli,web}/src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
])
