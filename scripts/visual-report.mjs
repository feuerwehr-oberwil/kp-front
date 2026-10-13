#!/usr/bin/env node
// The screenshot regression tests' verdict, for people (docs/testing/visual-regression.md).
//
//   node scripts/visual-report.mjs <playwright-json-report> <out-dir>
//
// Reads Playwright's JSON report of the `visual` project and
//   - prints a Markdown table (one row per state: same / changed by N px / no baseline / broke) —
//     CI appends it to the job summary;
//   - copies every state's NEW picture to <out-dir>/actual/<state>.png, and the diff images to
//     <out-dir>/diff/<state>.png. `just visual-accept <run-id>` takes <out-dir>/actual from the
//     run's artifact into e2e/visual/baseline/ — the same layout visual-baselines.yml uploads.
//
// No dependencies: the report is JSON, and a PNG's size sits at a fixed offset of its header.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [reportPath, outDir] = process.argv.slice(2)
if (!reportPath || !outDir) {
  console.error('usage: node scripts/visual-report.mjs <playwright-json-report> <out-dir>')
  process.exit(2)
}

const lines = ['### Screenshots vs `e2e/visual/baseline/`', '']
if (!existsSync(reportPath)) {
  lines.push('> [!WARNING]', '> No Playwright report: the run broke before any state was shot. See the job log.')
  console.log(lines.join('\n'))
  process.exit(0)
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'))

/** width × height of a PNG, from its IHDR chunk */
function pngArea(path) {
  const b = readFileSync(path)
  return b.readUInt32BE(16) * b.readUInt32BE(20)
}

function* tests(suite) {
  for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) yield { title: spec.title, test: t }
  for (const child of suite.suites ?? []) yield* tests(child)
}

const rows = []
for (const suite of report.suites ?? []) {
  for (const { title, test } of tests(suite)) {
    if (test.projectName !== 'visual') continue
    const result = test.results.at(-1)
    if (!result) continue
    const attach = (suffix) => result.attachments.find((a) => a.path && a.name.endsWith(suffix))?.path
    const actual = attach('-actual.png')
    const diff = attach('-diff.png')
    if (actual) { mkdirSync(join(outDir, 'actual'), { recursive: true }); copyFileSync(actual, join(outDir, 'actual', `${title}.png`)) }
    if (diff) { mkdirSync(join(outDir, 'diff'), { recursive: true }); copyFileSync(diff, join(outDir, 'diff', `${title}.png`)) }
    const message = (result.errors ?? []).map((e) => e.message ?? '').join('\n').replace(/\u001b\[[0-9;]*m/g, '')
    let verdict
    if (result.status === 'skipped') verdict = '⏭️ skipped'
    else if (result.status === 'passed') verdict = '✅ same'
    else if (/snapshot doesn't exist/i.test(message)) verdict = '🆕 no baseline yet'
    else {
      const px = message.match(/(\d+) pixels \(ratio/)
      if (px && actual) verdict = `❌ changed: ${px[1]} px (${(100 * Number(px[1]) / pngArea(actual)).toFixed(2)} %)`
      else if (/Expected an image \d+px by \d+px/.test(message)) verdict = '❌ changed size'
      else verdict = `💥 broke before the shot: ${(message.split('\n').find((l) => l.trim()) ?? result.status).trim().slice(0, 120)}`
    }
    rows.push({ title, verdict, ok: result.status === 'passed' || result.status === 'skipped' })
  }
}

lines.push('| State | Result |', '| --- | --- |', ...rows.map((r) => `| \`${r.title}\` | ${r.verdict} |`))
if (rows.some((r) => !r.ok)) {
  lines.push(
    '',
    'Expected, actual and diff pictures are in the run\'s **visual-results** artifact (`diff/` marks every changed pixel; ',
    'the Playwright report in it has a slider). **Unintended:** fix the change. **Intended:** `just visual-accept <run-id>` ',
    'and commit the new baselines on their own, saying why — never to turn this check green ',
    '([docs/testing/visual-regression.md](docs/testing/visual-regression.md)).',
  )
}
console.log(lines.join('\n'))
