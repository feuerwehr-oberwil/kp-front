#!/usr/bin/env node
// `pnpm knip`: dead code held to a ratchet (sweep C.14, 23.10.2026) – knip (config: knip.json)
// with its findings counted per kind (unused files, exports, types, dependencies …) against
// knip-baseline.json. Fails when a kind has MORE than its baseline (a kind missing from the
// file has 0) and prints those findings; a kind that went DOWN is a note – `--update` lowers
// the baseline (it never raises a count). ~200 superfluous exports piled up in three months
// before this existed; an export used only in its own file is not counted
// (`ignoreExportsUsedInFile`), the vitest and Playwright entries are knip's own plugins.
//
// Raising a count is a hand edit of the JSON, in the diff for a reviewer to see. Like the lint
// and style-debt ratchets: never raise it to pass – delete the dead code, or say in knip.json
// why a file is an entry nobody imports.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASELINE = resolve(import.meta.dirname, 'knip-baseline.json')
const update = process.argv.includes('--update')

/** knip exits 1 when it finds anything – the JSON on stdout is the answer either way */
function runKnip() {
  try {
    return execFileSync('pnpm', ['exec', 'knip', '--no-progress', '--reporter', 'json'], { encoding: 'utf-8', maxBuffer: 64 << 20 })
  } catch (e) {
    if (e.stdout) return e.stdout
    throw e
  }
}

const { issues } = JSON.parse(runKnip())
/** kind → ["file: name", …] */
const found = new Map()
for (const entry of issues) {
  for (const [kind, list] of Object.entries(entry)) {
    if (!Array.isArray(list) || list.length === 0) continue
    if (!found.has(kind)) found.set(kind, [])
    for (const item of list) {
      const names = typeof item === 'string' ? item : Array.isArray(item) ? item.map((x) => x.name).join(' = ') : item.name
      found.get(kind).push(`${entry.file}: ${names}`)
    }
  }
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'))
const counts = Object.fromEntries([...found].map(([kind, list]) => [kind, list.length]))
const kinds = [...new Set([...Object.keys(baseline.counts), ...Object.keys(counts)])].sort()

if (update) {
  const next = {}
  for (const kind of kinds) {
    const was = baseline.counts[kind] ?? 0
    const now = counts[kind] ?? 0
    if (now > was) {
      console.error(`knip --update never raises a count – ${kind} is at ${now}, baseline ${was}. Delete the dead code.`)
      process.exit(1)
    }
    if (now > 0) next[kind] = now
  }
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, counts: next }, null, 2) + '\n')
  console.log(`knip-baseline.json: ${Object.values(next).reduce((a, b) => a + b, 0)} findings across ${Object.keys(next).length} kinds`)
  process.exit(0)
}

let failed = false
for (const kind of kinds) {
  const was = baseline.counts[kind] ?? 0
  const now = counts[kind] ?? 0
  if (now > was) {
    failed = true
    console.error(`knip: ${kind} ${was} → ${now} – unused code, delete it (or name the entry in knip.json):`)
    for (const line of found.get(kind)) console.error(`  ${line}`)
  } else if (now < was) {
    console.log(`knip: ${kind} went down ${was} → ${now} – lower the baseline when convenient: node scripts/knip-ratchet.mjs --update`)
  }
}
if (!failed) console.log(`knip: ${Object.values(counts).reduce((a, b) => a + b, 0)} findings, none above the baseline`)
process.exit(failed ? 1 : 0)
