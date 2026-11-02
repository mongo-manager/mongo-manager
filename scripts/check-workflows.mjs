// Supply-chain rules for GitHub workflows (spec S17): actions and images pinned by digest,
// least-privilege permissions, no pull_request_target, and no untrusted event text expanded inside
// a script. The YAML is parsed, so flow style, quoting and multi-line values cannot hide anything.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml'

// `${{ … github.event… }}` or head_ref, in any spacing or index form, possibly across lines.
const UNTRUSTED = /\$\{\{[^}]*?\bgithub\s*(?:\.\s*(?:event|head_ref)\b|\[\s*['"](?:event|head_ref)['"]\s*\])/
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/
const DIGEST = /@sha256:[0-9a-f]{64}$/
// name[:tag][@digest], the shape of an image reference on a docker command line.
const IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?(?:@sha256:[0-9a-f]{64})?$/

const pairs = (node) => (isMap(node) ? node.items : [])
const items = (node) => (isSeq(node) ? node.items : [])
const get = (node, key) => pairs(node).find((p) => isScalar(p.key) && p.key.value === key)?.value
const text = (node) => (isScalar(node) ? String(node.value) : undefined)

/** Problems in one workflow file, as `file:line: message`. */
export function checkWorkflow(source, file) {
  const lines = new LineCounter()
  const doc = parseDocument(source, { lineCounter: lines })
  if (doc.errors.length) return [`${file}: not valid YAML (${doc.errors[0].message})`]
  const problems = []
  const lineOf = (offset) => lines.linePos(offset).line
  const at = (node) => (node?.range ? `${file}:${lineOf(node.range[0])}` : file)
  const root = doc.contents
  // Images built in this workflow are local, not pulled.
  const local = new Set([...source.matchAll(/(?:-t|--tag)[ =]["']?([^\s"']+)/g)].map((m) => m[1]))

  const permissions = get(root, 'permissions')
  if (permissions === undefined) problems.push(`${file}: no top-level permissions`)
  const checkPermissions = (node) => {
    if (text(node) === 'write-all') problems.push(`${at(node)}: write-all permissions`)
  }
  checkPermissions(permissions)

  const on = get(root, 'on')
  const triggers = isScalar(on) ? [on] : isSeq(on) ? on.items : pairs(on).map((p) => p.key)
  for (const t of triggers) {
    if (text(t) === 'pull_request_target') {
      problems.push(`${at(t)}: pull_request_target runs untrusted code with secrets`)
    }
  }

  const checkUses = (node) => {
    const value = text(node)
    if (value === undefined || value.startsWith('./')) return
    if (value.startsWith('docker://') ? !DIGEST.test(value) : !PINNED_ACTION.test(value)) {
      problems.push(`${at(node)}: ${value} is not pinned to a commit SHA`)
      return
    }
    const end = node.range[1]
    const eol = source.indexOf('\n', end)
    if (!/#\s*\S/.test(source.slice(end, eol < 0 ? undefined : eol))) {
      problems.push(`${at(node)}: pinned action has no "# <tag>" comment`)
    }
  }
  const checkImage = (node) => {
    const value = text(node)
    if (value !== undefined && !DIGEST.test(value)) {
      problems.push(`${at(node)}: image ${value} is not pinned by digest`)
    }
  }
  const checkScript = (node, what) => {
    if (!node?.range) return
    const raw = source.slice(node.range[0], node.range[1])
    const hit = UNTRUSTED.exec(raw)
    if (hit) {
      problems.push(
        `${file}:${lineOf(node.range[0] + hit.index)}: \${{ github.event.* }} or github.head_ref inside ${what}: pass it through env instead`,
      )
    }
    if (what !== 'run') return
    // Shell commands, with backslash continuations joined.
    for (const command of String(text(node) ?? '').split(/(?<!\\)\n/)) {
      if (!/\bdocker\s+(?:run|pull|create)\b/.test(command)) continue
      for (const token of command.replace(/\\\n/g, ' ').split(/\s+/)) {
        const image = token.replace(/^["']|["']$/g, '')
        if (!IMAGE.test(image) || !/[:@]/.test(image) || DIGEST.test(image) || local.has(image)) continue
        problems.push(`${at(node)}: image ${image} is not pinned by digest`)
      }
    }
  }

  for (const job of pairs(get(root, 'jobs')).map((p) => p.value)) {
    checkPermissions(get(job, 'permissions'))
    checkUses(get(job, 'uses'))
    const container = get(job, 'container')
    checkImage(isMap(container) ? get(container, 'image') : container)
    for (const service of pairs(get(job, 'services'))) checkImage(get(service.value, 'image'))
    for (const step of items(get(job, 'steps'))) {
      const uses = get(step, 'uses')
      checkUses(uses)
      if (
        /^actions\/checkout@/.test(text(uses) ?? '') &&
        text(get(get(step, 'with'), 'persist-credentials')) !== 'false'
      ) {
        problems.push(
          `${at(uses)}: checkout keeps the job token in .git/config: set persist-credentials: false`,
        )
      }
      checkScript(get(step, 'run'), 'run')
      if (/^actions\/github-script@/.test(text(uses) ?? ''))
        checkScript(get(get(step, 'with'), 'script'), 'script')
    }
  }
  return problems
}

if (import.meta.main) {
  const dir = join(import.meta.dirname, '..', '.github', 'workflows')
  const problems = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => checkWorkflow(readFileSync(join(dir, f), 'utf8'), `.github/workflows/${f}`))
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
  console.log('workflows: every action and image pinned, permissions least-privilege')
}
