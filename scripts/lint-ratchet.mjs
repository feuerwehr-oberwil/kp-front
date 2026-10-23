#!/usr/bin/env node
// `pnpm lint`: eslint, with the warnings held to a per-rule ratchet (08.10.2026).
//
// The old gate was ONE number, `--max-warnings=411`: fixing ten `no-explicit-any` left room for
// ten new `react-hooks/refs`, and a new kind of warning slipped in under the total. Now every rule
// has its own count in `eslint-baseline.json`, and this fails when
//
//   · any error is reported (as before), or
//   · a rule has MORE warnings than its baseline (a rule missing from the file has 0), or
//   · a rule has FEWER — the baseline must come down with the fix, or the room is there for the
//     next one to fill. `pnpm lint:update` lowers it (it never raises a count); commit the file.
//
// The same two-way hold applies to what an `eslint-disable` directive SILENCES, per rule (B.14,
// 23.10.2026): a disable line is the cheapest way to make a warning count go down, and it used to
// be invisible here (123 `exhaustive-deps` disables beside a baseline of 20). They are counted
// from ESLint's own suppressed messages, so a directive that silences nothing is not one of them
// (ESLint reports that as an unused directive, a warning of its own).
//
// Raising a count is a hand edit of the JSON, in the diff for a reviewer to see. Like the style
// debt ratchet (src/styles/styleDebt.test.ts): never raise it to pass.
//
// Only the warnings of a rule that went UP are printed (with file:line) — the rest is a table.
// `--all` prints every warning, the way plain eslint does. Results are cached under
// node_modules/.cache/eslint (content-hashed, so a checkout's fresh mtimes don't invalidate it):
// a re-run touches only the files you changed. `--no-cache` for a cold run.
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { ESLint } from 'eslint'

const BASELINE = resolve(import.meta.dirname, 'eslint-baseline.json')
const args = new Set(process.argv.slice(2))
const update = args.has('--update')

const eslint = new ESLint({
  cache: !args.has('--no-cache'),
  cacheLocation: 'node_modules/.cache/eslint/',
  cacheStrategy: 'content',
})
const results = await eslint.lintFiles(['.'])

/** rule → [{ file, line, message }] — warnings only; `null` rule ids (unused directives) as their own key */
const warnings = new Map()
/** rule → [{ file, line }] silenced by an eslint-disable directive (any severity) */
const silenced = new Map()
let errors = 0
for (const r of results) {
  for (const m of r.suppressedMessages ?? []) {
    if (!m.ruleId) continue
    if (!silenced.has(m.ruleId)) silenced.set(m.ruleId, [])
    silenced.get(m.ruleId).push({ file: relative(process.cwd(), r.filePath), line: m.line })
  }
  for (const m of r.messages) {
    if (m.severity === 2) { errors++; continue }
    const rule = m.ruleId ?? '(unused eslint-disable)'
    if (!warnings.has(rule)) warnings.set(rule, [])
    warnings.get(rule).push({ file: relative(process.cwd(), r.filePath), line: m.line, message: m.message.split('\n')[0] })
  }
}

if (errors > 0 || args.has('--all')) {
  const formatter = await eslint.loadFormatter('stylish')
  const shown = args.has('--all') ? results : ESLint.getErrorResults(results)
  process.stdout.write(await formatter.format(shown))
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'))
baseline.silenced ??= {}
const counts = Object.fromEntries([...warnings].map(([rule, list]) => [rule, list.length]))
const silencedCounts = Object.fromEntries([...silenced].map(([rule, list]) => [rule, list.length]))
const rules = [...new Set([...Object.keys(baseline.rules), ...Object.keys(counts)])].sort()
const silencedRules = [...new Set([...Object.keys(baseline.silenced), ...Object.keys(silencedCounts)])].sort()

if (update) {
  /** the lowered table, or exit when a count went up (`what`: the kind, for the message) */
  const lowered = (keys, held, now, what) => {
    const next = {}
    for (const rule of keys) {
      const was = held[rule] ?? 0
      const n = now[rule] ?? 0
      if (n > was) {
        console.error(`lint:update never raises a count — ${what} ${rule} is at ${n}, baseline ${was}. Fix the new ones.`)
        process.exit(1)
      }
      if (n > 0) next[rule] = n
    }
    return next
  }
  const next = lowered(rules, baseline.rules, counts, 'warnings of')
  const nextSilenced = lowered(silencedRules, baseline.silenced, silencedCounts, 'disabled')
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, rules: next, silenced: nextSilenced }, null, 2) + '\n')
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)
  console.log(`eslint-baseline.json: ${sum(next)} warnings across ${Object.keys(next).length} rules, ${sum(nextSilenced)} silenced by eslint-disable`)
  process.exit(errors > 0 ? 1 : 0)
}

const up = []
const down = []
for (const rule of rules) {
  const was = baseline.rules[rule] ?? 0
  const now = counts[rule] ?? 0
  if (now > was) up.push({ rule, was, now })
  else if (now < was) down.push({ rule, was, now })
}
const silencedUp = []
for (const rule of silencedRules) {
  const was = baseline.silenced[rule] ?? 0
  const now = silencedCounts[rule] ?? 0
  if (now > was) silencedUp.push({ rule, was, now })
  else if (now < was) down.push({ rule: `${rule} (silenced)`, was, now })
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)
const width = Math.max(...rules.map((r) => r.length))
console.log(`eslint: ${errors} errors, ${total} warnings (baseline ${Object.values(baseline.rules).reduce((a, b) => a + b, 0)})`)
for (const rule of rules) {
  const was = baseline.rules[rule] ?? 0
  const now = counts[rule] ?? 0
  const mark = now > was ? `  ▲ +${now - was}` : now < was ? `  ▼ −${was - now}` : ''
  console.log(`  ${rule.padEnd(width)}  ${String(now).padStart(4)}${mark}`)
}

const silencedWidth = Math.max(0, ...silencedRules.map((r) => r.length))
if (silencedRules.length > 0) console.log('silenced by eslint-disable:')
for (const rule of silencedRules) {
  const was = baseline.silenced[rule] ?? 0
  const now = silencedCounts[rule] ?? 0
  const mark = now > was ? `  ▲ +${now - was}` : now < was ? `  ▼ −${was - now}` : ''
  console.log(`  ${rule.padEnd(silencedWidth)}  ${String(now).padStart(4)}${mark}`)
}

for (const { rule, was, now } of up) {
  console.error(`\n✗ ${rule}: ${now} warnings, baseline ${was}. These are all of them — the new ones are among them:`)
  for (const w of warnings.get(rule)) console.error(`    ${w.file}:${w.line}  ${w.message}`)
}
for (const { rule, was, now } of silencedUp) {
  console.error(`\n✗ ${rule}: ${now} silenced by eslint-disable, baseline ${was}. Fix the code rather than silence it — all of them:`)
  for (const w of silenced.get(rule)) console.error(`    ${w.file}:${w.line}`)
}
if (down.length > 0) {
  console.error(`\n✗ fewer warnings than the baseline (${down.map((d) => `${d.rule} ${d.was}→${d.now}`).join(', ')}) — good.`)
  console.error('  Lower the baseline with them: `pnpm lint:update`, and commit eslint-baseline.json.')
}
process.exit(errors > 0 || up.length > 0 || silencedUp.length > 0 || down.length > 0 ? 1 : 0)
