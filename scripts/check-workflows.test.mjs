import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkWorkflow } from './check-workflows.mjs'

const SHA = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'
const ok = `name: CI
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@${SHA} # v5.1.0
      - run: echo hi
`

test('a workflow with pinned actions and read-only permissions passes', () => {
  assert.deepEqual(checkWorkflow(ok, 'ci.yml'), [])
})

test('every action is pinned to a full commit SHA with its tag in a comment (S17)', () => {
  assert.deepEqual(checkWorkflow(ok.replace(`@${SHA} # v5.1.0`, '@v5'), 'ci.yml'), [
    'ci.yml:9: actions/cache@v5 is not pinned to a commit SHA',
  ])
  assert.deepEqual(checkWorkflow(ok.replace(' # v5.1.0', ''), 'ci.yml'), [
    'ci.yml:9: pinned action has no "# <tag>" comment',
  ])
  assert.deepEqual(checkWorkflow(ok.replace(`actions/cache@${SHA}`, './local-action'), 'ci.yml'), [])
})

test('top-level permissions are required and never write-all', () => {
  assert.deepEqual(checkWorkflow(ok.replace('permissions:\n  contents: read\n', ''), 'ci.yml'), [
    'ci.yml: no top-level permissions',
  ])
  assert.deepEqual(
    checkWorkflow(ok.replace('permissions:\n  contents: read', 'permissions: write-all'), 'ci.yml'),
    ['ci.yml:3: write-all permissions'],
  )
})

test('pull_request_target is refused', () => {
  assert.deepEqual(checkWorkflow(ok.replace('on: push', 'on: pull_request_target'), 'ci.yml'), [
    'ci.yml:2: pull_request_target runs untrusted code with secrets',
  ])
})

test('untrusted event text is never expanded inside a run script', () => {
  const inline = ok.replace('- run: echo hi', '- run: echo "${{ github.event.pull_request.title }}"')
  assert.deepEqual(checkWorkflow(inline, 'ci.yml'), [
    'ci.yml:10: ${{ github.event.* }} or github.head_ref inside run: pass it through env instead',
  ])
  const block = ok.replace(
    '- run: echo hi',
    '- run: |\n          echo ok\n          echo ${{ github.head_ref }}',
  )
  assert.deepEqual(checkWorkflow(block, 'ci.yml'), [
    'ci.yml:12: ${{ github.event.* }} or github.head_ref inside run: pass it through env instead',
  ])
  const viaEnv = ok.replace(
    '- run: echo hi',
    '- env:\n          TITLE: ${{ github.event.pull_request.title }}\n        run: echo "$TITLE"',
  )
  assert.deepEqual(checkWorkflow(viaEnv, 'ci.yml'), [])
})

// Final review 1f-3, Important 2: shapes the line-based check let through.
const job = (steps) => `name: CI
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
${steps}
`
const refused = (text) => checkWorkflow(text, 'ci.yml').length > 0

test('flow-style steps are checked too', () => {
  assert.ok(refused(job('      - { uses: actions/cache@v4 }')))
  assert.ok(refused(ok.replace(/steps:[\s\S]*/, 'steps: [ { uses: actions/cache@v4 } ]\n')))
})

test('untrusted text is found in every form of a run script', () => {
  assert.ok(refused(job('      - run:\n          echo ${{ github.event.issue.title }}')))
  assert.ok(refused(job('      - run: >-\n          echo ${{\n          github.event.issue.title }}')))
  assert.ok(refused(job("      - run: echo ${{ github['event'].issue.title }}")))
  assert.ok(refused(job('      - run: echo ${{ github . head_ref }}')))
})

test('github-script code is a script too', () => {
  assert.ok(
    refused(
      job(
        `      - uses: actions/github-script@${SHA} # v7\n        with:\n          script: console.log('\${{ github.event.issue.body }}')`,
      ),
    ),
  )
})

test('quoted write-all and job-level write-all are refused', () => {
  assert.ok(refused(ok.replace('permissions:\n  contents: read', 'permissions: "write-all"')))
  assert.ok(
    refused(
      ok.replace('    runs-on: ubuntu-latest', '    permissions: write-all\n    runs-on: ubuntu-latest'),
    ),
  )
})

test('pull_request_target in any form is refused', () => {
  assert.ok(refused(ok.replace('on: push', 'on: [push, pull_request_target]')))
  assert.ok(refused(ok.replace('on: push', 'on:\n  pull_request_target:\n    types: [opened]')))
})

test('container, service and docker images are pinned by digest', () => {
  const D = `@sha256:${'a'.repeat(64)}`
  assert.ok(
    refused(ok.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    container: node:24')),
  )
  assert.ok(
    refused(
      ok.replace(
        '    runs-on: ubuntu-latest',
        '    runs-on: ubuntu-latest\n    services:\n      db:\n        image: mongo:8',
      ),
    ),
  )
  assert.ok(refused(job('      - run: docker run --rm mongo:8 mongod --version')))
  assert.ok(refused(job('      - run: |\n          docker run -d --name m \\\n            mongo:8')))
  assert.ok(
    !refused(
      ok.replace('    runs-on: ubuntu-latest', `    runs-on: ubuntu-latest\n    container: node:24${D}`),
    ),
  )
  assert.ok(!refused(job(`      - run: docker run --rm -v "$PWD:/w" -e A=b:c mongo:8${D} mongod`)))
  // An image built earlier in the same workflow is local, not pulled.
  assert.ok(
    !refused(
      job(
        '      - run: docker build -t mongo-manager:ci .\n      - run: docker run --rm mongo-manager:ci version',
      ),
    ),
  )
})
