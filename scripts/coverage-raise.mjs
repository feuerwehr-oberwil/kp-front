#!/usr/bin/env node
// Lift the vitest coverage floor (scripts/coverage-floor.json) to what the last
// `pnpm test:coverage` measured — never lower it (08.10.2026).
//
// The floor sits half a point under the measurement, rounded down to a tenth: coverage moves a
// little with every refactor that deletes covered lines, and a floor at the exact number would
// fail the next unrelated PR. Commit the file when it changed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FLOOR = resolve(import.meta.dirname, 'coverage-floor.json')
const SUMMARY = resolve('coverage/coverage-summary.json')
const SLACK = 0.5

if (!existsSync(SUMMARY)) {
  console.error('coverage-raise: no coverage/coverage-summary.json — run `pnpm test:coverage` first')
  process.exit(1)
}
const total = JSON.parse(readFileSync(SUMMARY, 'utf-8')).total
const file = JSON.parse(readFileSync(FLOOR, 'utf-8'))
let raised = false
for (const metric of ['statements', 'branches', 'functions', 'lines']) {
  const measured = total[metric].pct
  const candidate = Math.floor((measured - SLACK) * 10) / 10
  const was = file.floor[metric] ?? 0
  if (candidate > was) {
    file.floor[metric] = candidate
    raised = true
  }
  console.log(`  ${metric.padEnd(10)} measured ${measured.toFixed(2).padStart(6)} %  floor ${String(was).padStart(5)} → ${file.floor[metric]}`)
}
writeFileSync(FLOOR, JSON.stringify(file, null, 2) + '\n')
console.log(raised ? 'scripts/coverage-floor.json raised — commit it.' : 'floor unchanged.')
