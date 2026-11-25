#!/usr/bin/env node
// `node scripts/baseline-guard.mjs [--base <ref>]` (CI's «Static analysis», `just ci-static-analysis`):
// fails when a commit of this branch loosens a ratchet or a baseline and also changes anything
// else. The repo rule (docs/testing/ci.md): a deliberate change goes in its own commit, with the reason – a raise beside
// a feature hides in the feature's diff; alone it is a commit a reviewer reads.
//
// It walks the non-merge commits from the merge base with `--base` (default origin/main) to HEAD.
// For every commit that changes a file in BASELINES it compares the limits that file sets with its
// parent's, limit by limit. Tightening always passes; so does a loosening in a commit that touches only files of
// BASELINES. Work not yet committed is not judged.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { judge as judgeMetric, speedFactor, toleranceFor } from './perf-gate.mjs'

/** a debt count: a key that is missing counts as 0, so a new key with a count is a raise */
const COUNT = { looser: 'up', absent: 0 }
/** a budget or a threshold: a missing key is no limit at all, so removing one is a raise */
const CEILING = { looser: 'up', absent: Infinity }
/** a floor: removing one is a drop to nothing */
const FLOOR = { looser: 'down', absent: -Infinity }

/** the numeric leaves of a parsed JSON value whose key path `match` accepts, each held to `rule` */
const leavesOf = (rule, match = () => true) => (json) => {
  const out = new Map()
  const walk = (value, path) => {
    if (typeof value === 'number') {
      if (match(path)) out.set(path.join(' › '), { value, rule })
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, [...path, k])
  }
  walk(json, [])
  return out
}

/** what scripts/check-bundle-size.mjs fails above, per chunk: its gzip size plus its own budget or the global one */
function bundleLimits(json) {
  const out = new Map()
  for (const [name, c] of Object.entries(json.chunks ?? {})) {
    const budget = c.budgetPercent ?? json.budgetPercent ?? Infinity
    out.set(`chunks › ${name} › gzip limit`, { value: c.gzip * (1 + budget / 100), rule: CEILING })
  }
  return out
}

/** a file read as limits (parsed JSON → key → `{ value, rule }`), compared limit by limit */
const byLimits = (limitsOf) => (before, after) => {
  const was = limitsOf(before)
  const now = limitsOf(after)
  const out = []
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const { rule } = was.get(key) ?? now.get(key)
    const a = was.get(key)?.value ?? rule.absent
    const b = now.get(key)?.value ?? rule.absent
    if (rule.looser === 'up' ? b > a : b < a) out.push(`${key}: ${show(a)} → ${show(b)}`)
  }
  return out
}

/**
 * The perf gate's limit for one metric depends on the runner: a time is scaled by
 * speedFactor(runner calibration, baseline calibration), and its slack is max(abs, rel × expected)
 * (scripts/perf-gate.mjs). Both are piecewise linear in the runner's calibration, so comparing the
 * two sides at every bend of either finds any runner on which `after` allows more.
 */
function perfLoosened(before, after) {
  const out = []
  for (const [key, m] of Object.entries(before.metrics ?? {})) {
    const n = after.metrics?.[key]
    if (!n) {
      out.push(`metrics › ${key}: removed`)
      continue
    }
    const limit = (file, metric, runner) =>
      judgeMetric({
        key,
        unit: metric.unit,
        base: metric.value,
        now: metric.value,
        speed: metric.unit === 'ms' ? speedFactor(runner, file.calibration) : 1,
        overrides: file.tolerance ?? {},
      }).limit
    const runners = [0, ...bends(key, before, m), ...bends(key, after, n)]
    const runner = runners.find((r) => limit(after, n, r) > limit(before, m, r))
    if (runner === undefined) continue
    const on = runner ? ` (runner calibration ${show(runner)} ms)` : ''
    out.push(`metrics › ${key} limit: ${show(limit(before, m, runner))} → ${show(limit(after, n, runner))}${on}`)
  }
  return out
}

/** the runner calibrations at which one side's time limit bends: both ends of the speed clamp, and where abs and rel slack cross */
function bends(key, file, metric) {
  const c = file.calibration
  if (metric.unit !== 'ms' || !c) return []
  const { abs, rel } = toleranceFor(key, metric.unit, file.tolerance ?? {})
  const cross = abs / (rel * metric.value)
  return [c, 1.5 * c, ...(cross > 1 && cross < 1.5 ? [cross * c] : [])]
}

/**
 * jscpd's threshold, and the sizes that decide which clones it counts at all: a raised minimum or
 * a lowered maximum counts fewer. A missing key is jscpd's default.
 */
const JSCPD = {
  threshold: CEILING,
  minTokens: { looser: 'up', absent: 50 },
  minLines: { looser: 'up', absent: 5 },
  maxLines: { looser: 'down', absent: 1000 },
}
function jscpdLimits(json) {
  const out = new Map()
  for (const [key, rule] of Object.entries(JSCPD))
    for (const [k, v] of leavesOf(rule, (p) => p.length === 1 && p[0] === key)(json)) out.set(k, v)
  return out
}

/**
 * Every baseline file and how to tell a loosening: `(before, after) → lines`, over parsed JSON.
 * A file whose numbers combine (a budget per chunk, a tolerance per metric) is judged by the
 * limit they make. src/components/controlDebt.test.ts keeps its baseline in TypeScript and is
 * not covered.
 */
export const BASELINES = {
  'scripts/eslint-baseline.json': byLimits(leavesOf(COUNT, (p) => p[0] === 'rules' || p[0] === 'silenced')),
  'scripts/knip-baseline.json': byLimits(leavesOf(COUNT, (p) => p[0] === 'counts')),
  'src/styles/styleDebt.baseline.json': byLimits(leavesOf(COUNT)),
  'scripts/bundle-baseline.json': byLimits(bundleLimits),
  'scripts/coverage-floor.json': byLimits(leavesOf(FLOOR, (p) => p[0] === 'floor')),
  '.jscpd.json': byLimits(jscpdLimits),
  'backend/.jscpd.json': byLimits(jscpdLimits),
  'e2e/perf/baseline.json': perfLoosened,
  'stryker.config.json': byLimits(leavesOf(FLOOR, (p) => p[0] === 'thresholds' && p[1] === 'break')),
}

const show = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : '–')

/**
 * The limits `after` loosened against `before` in one baseline file, as readable lines.
 * `before`/`after` are parsed JSON, or `undefined` when the file does not exist on that side:
 * a new file is a new ratchet and loosens nothing, a removed one drops all of its limits.
 */
export function loosened(file, before, after) {
  if (before === undefined) return []
  if (after === undefined) return ['the file is removed']
  return BASELINES[file](before, after)
}

/**
 * The verdict over a branch's commits. Each commit is `{ sha, subject, changed, baselines }`:
 * `changed` lists every path it touches, `baselines` maps each baseline file among them to its
 * parsed `{ before, after }`. Returns one problem per commit that loosens and touches more.
 */
export function judge(commits) {
  const problems = []
  for (const c of commits) {
    const raised = Object.entries(c.baselines).flatMap(([file, { before, after }]) =>
      loosened(file, before, after).map((line) => `${file} · ${line}`),
    )
    const others = c.changed.filter((f) => !(f in BASELINES))
    if (raised.length && others.length) problems.push({ sha: c.sha, subject: c.subject, raised, others })
  }
  return problems
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })

/** a file's parsed JSON at a revision; `undefined` when it does not exist there */
function readAt(rev, file) {
  let text
  try {
    text = git('show', `${rev}:${file}`)
  } catch {
    return undefined
  }
  return JSON.parse(text)
}

/** this branch's non-merge commits since the merge base with `base`, oldest first */
function branchCommits(base) {
  const from = git('merge-base', base, 'HEAD').trim()
  const shas = git('rev-list', '--reverse', '--no-merges', `${from}..HEAD`).split('\n').filter(Boolean)
  return shas.map((sha) => {
    const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha).split('\n').filter(Boolean)
    const baselines = {}
    for (const file of changed.filter((f) => f in BASELINES))
      baselines[file] = { before: readAt(`${sha}^`, file), after: readAt(sha, file) }
    return { sha, subject: git('log', '-1', '--format=%s', sha).trim(), changed, baselines }
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--base')
  const base = at > 0 ? process.argv[at + 1] : 'origin/main'
  const commits = branchCommits(base)
  const problems = judge(commits)
  for (const p of problems) {
    console.error(`✗ ${p.sha.slice(0, 9)} ${p.subject}`)
    for (const line of p.raised) console.error(`    loosens ${line}`)
    console.error(`    and also changes ${p.others.slice(0, 5).join(', ')}${p.others.length > 5 ? ' …' : ''}`)
  }
  if (problems.length) {
    console.error(
      '\nA ratchet or baseline moves the loose way only on purpose: in a commit of its own that touches' +
        ' only baseline files, with the reason in its message (docs/testing/ci.md).',
    )
    process.exit(1)
  }
  console.log(`baseline-guard: ${commits.length} commit(s) since ${base}, no baseline loosened beside other changes`)
}
