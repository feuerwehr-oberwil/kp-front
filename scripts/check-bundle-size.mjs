#!/usr/bin/env node
// Bundle budget (08.10.2026): the chunks that decide how fast the app starts — and how much a
// tablet re-downloads after every deploy — may not grow unnoticed.
//
// Gzipped size of each chunk below against scripts/bundle-baseline.json; fails when one grew by more
// than its budget (default 5 %). A chunk that disappears or matches twice fails too: the
// naming changed and this check has to follow it, not pass by measuring nothing.
//
//   entry      the script index.html loads — on every route, before anything paints
//   App        the incident workspace (lazy, but it IS the app on an Einsatz)
//   maplibre   its own chunk on purpose (vite.config.ts · codeSplitting); a stray import that
//              pulled it back into the entry shows here and in the entry
//   pdfWorker  pdf.js' worker, the biggest file in the build
//   css        the stylesheet index.html loads
//
// Run after `pnpm build` (CI does): `node scripts/check-bundle-size.mjs [distDir]`.
// `--update` writes today's sizes as the new baseline — for a growth the change deliberately
// buys, in its own commit with the reason, like a perf baseline (`just perf-accept`). A chunk that
// SHRANK passes; lowering the baseline then is welcome, not required.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const argv = process.argv.slice(2)
const update = argv.includes('--update')
const dist = resolve(argv.find((a) => !a.startsWith('--')) ?? 'dist')
const BASELINE = resolve(import.meta.dirname, 'bundle-baseline.json')

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`check-bundle-size: no build at ${dist} — run \`pnpm build\` first`)
  process.exit(1)
}

const assets = readdirSync(join(dist, 'assets'))
const html = readFileSync(join(dist, 'index.html'), 'utf-8')
const fromHtml = (re) => [...html.matchAll(re)].map((m) => m[1].replace(/^\/?assets\//, ''))
const byPrefix = (prefix, ext) => assets.filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(ext) && !f.slice(prefix.length + 1, -ext.length).includes('.'))

const CHUNKS = {
  entry: () => fromHtml(/<script[^>]+src="(\/?assets\/[^"]+\.js)"/g),
  App: () => byPrefix('App', '.js'),
  maplibre: () => byPrefix('maplibre', '.js'),
  pdfWorker: () => byPrefix('pdfWorkerEntry', '.js'),
  css: () => fromHtml(/<link[^>]+rel="stylesheet"[^>]+href="(\/?assets\/[^"]+\.css)"/g),
}

const failures = []
const sizes = {}
for (const [name, find] of Object.entries(CHUNKS)) {
  const files = find()
  if (files.length !== 1) {
    failures.push(`${name}: expected exactly one file, found ${files.length} (${files.join(', ') || 'none'}) — the chunk naming changed; update CHUNKS in this script`)
    continue
  }
  const raw = readFileSync(join(dist, 'assets', files[0]))
  sizes[name] = { file: files[0], raw: raw.length, gzip: gzipSync(raw).length }
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf-8')) : { budgetPercent: 5, chunks: {} }
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

if (update) {
  if (failures.length) { failures.forEach((f) => console.error(`✗ ${f}`)); process.exit(1) }
  const chunks = Object.fromEntries(Object.entries(sizes).map(([n, s]) => [n, { gzip: s.gzip, raw: s.raw, ...(baseline.chunks[n]?.budgetPercent ? { budgetPercent: baseline.chunks[n].budgetPercent } : {}) }]))
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, chunks }, null, 2) + '\n')
  console.log("scripts/bundle-baseline.json updated:")
  for (const [n, s] of Object.entries(sizes)) console.log(`  ${n.padEnd(10)} ${kb(s.gzip).padStart(10)} gzip  (${kb(s.raw)} raw)`)
  process.exit(0)
}

console.log(`bundle sizes (gzip) against scripts/bundle-baseline.json, budget +${baseline.budgetPercent} % unless set per chunk:`)
for (const [name, s] of Object.entries(sizes)) {
  const base = baseline.chunks[name]
  if (!base) {
    failures.push(`${name}: not in scripts/bundle-baseline.json — add it with \`node scripts/check-bundle-size.mjs --update\``)
    continue
  }
  const budget = base.budgetPercent ?? baseline.budgetPercent
  const delta = ((s.gzip - base.gzip) / base.gzip) * 100
  const sign = delta >= 0 ? '+' : '−'
  console.log(`  ${name.padEnd(10)} ${kb(s.gzip).padStart(10)}  ${sign}${Math.abs(delta).toFixed(1).padStart(5)} %  (baseline ${kb(base.gzip)}, ${s.file})`)
  if (delta > budget) {
    failures.push(`${name} grew ${delta.toFixed(1)} % (${kb(base.gzip)} → ${kb(s.gzip)} gzip), budget ${budget} %. ` +
      'Find what came in (an import that pulled a library into this chunk?), or — if the change buys it on purpose — ' +
      '`pnpm build && node scripts/check-bundle-size.mjs --update` in its own commit, with the reason.')
  }
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`)
  process.exit(1)
}
console.log('✓ within budget')
