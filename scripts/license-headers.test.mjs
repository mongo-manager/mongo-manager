// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COPYRIGHT, SPDX, covered, hasHeader, withHeader } from './license-headers.mjs'

test('a script, a component and a style each get the notice as they write a comment', () => {
  assert.equal(
    withHeader('a/b.ts', 'export const a = 1\n'),
    `// ${SPDX}\n// ${COPYRIGHT}\nexport const a = 1\n`,
  )
  assert.equal(
    withHeader('a/B.vue', '<template><p /></template>\n'),
    `<!-- ${SPDX} -->\n<!-- ${COPYRIGHT} -->\n<template><p /></template>\n`,
  )
  assert.equal(withHeader('a/b.css', 'p {}\n'), `/* ${SPDX} */\n/* ${COPYRIGHT} */\np {}\n`)
})

test('a #! line stays first, the notice right after it', () => {
  const text = withHeader('scripts/x.mjs', '#!/usr/bin/env node\nconsole.log(1)\n')
  assert.equal(text, `#!/usr/bin/env node\n// ${SPDX}\n// ${COPYRIGHT}\nconsole.log(1)\n`)
  assert.equal(hasHeader('scripts/x.mjs', text), true)
})

test('a file that has the notice is left as it is', () => {
  const text = `// ${SPDX}\n// ${COPYRIGHT}\nexport {}\n`
  assert.equal(withHeader('a.ts', text), text)
})

test('the notice must be the first lines, whole', () => {
  assert.equal(hasHeader('a.ts', `export {}\n// ${SPDX}\n// ${COPYRIGHT}\n`), false)
  assert.equal(hasHeader('a.ts', `// ${SPDX}\nexport {}\n`), false)
  assert.equal(hasHeader('a.ts', `// SPDX-License-Identifier: MIT\n// ${COPYRIGHT}\n`), false)
  assert.equal(hasHeader('a.ts', `// ${SPDX}\n// Copyright (C) 2027 Someone Else\n`), false)
})

test('source files are covered, the MIT plugin starter and other files are not', () => {
  for (const path of ['packages/web/src/App.vue', 'scripts/a.mjs', 'site/styles.css', 'x.d.ts'])
    assert.equal(covered(path), true, path)
  for (const path of ['packages/plugins/starter/main.js', 'README.md', 'package.json', 'a.html'])
    assert.equal(covered(path), false, path)
})

test('every source file of the repository starts with the notice', () => {
  const script = fileURLToPath(new URL('./license-headers.mjs', import.meta.url))
  execFileSync(process.execPath, [script], { stdio: 'pipe' })
})
