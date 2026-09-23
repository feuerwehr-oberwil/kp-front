#!/usr/bin/env node
// Holds the three facts about sourcemaps a production build must keep (24.09.2026, see
// docs/SOURCEMAPS.md and vite.config.ts · build.sourcemap):
//
//   1. the maps EXIST — at least for the entry chunk, which is where a field stack points;
//   2. no shipped file POINTS at one (`sourceMappingURL`) — `hidden`, not `true`;
//   3. the service worker PRECACHES none — they are for the person reading a crash, never for
//      the tablet, and together they are several times the size of the code.
//
// Run after `pnpm build` (CI does): `node scripts/check-sourcemaps.mjs [distDir]`. Exits 1 and
// says which fact broke.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'dist')
const failures = []
const fail = (msg) => failures.push(msg)

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`check-sourcemaps: no build at ${dist} — run \`pnpm build\` first`)
  process.exit(1)
}

/** every file under `dir`, relative to `dist` */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full.slice(dist.length + 1))
  }
  return out
}
const files = walk(dist)
const maps = files.filter((f) => f.endsWith('.map'))

// 1 — the maps exist, and the entry chunk has one
if (maps.length === 0) fail('no .map files in the build — is build.sourcemap still "hidden"?')
const html = readFileSync(join(dist, 'index.html'), 'utf-8')
const entries = [...html.matchAll(/<script[^>]+src="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1])
if (entries.length === 0) fail('index.html names no entry script — cannot check its map')
for (const entry of entries) {
  if (!files.includes(`${entry}.map`)) fail(`the entry chunk ${entry} has no ${entry}.map`)
}

// 2 — nothing that ships points at a map
const SHIPPED = /\.(m?js|css|html)$/
for (const f of files.filter((name) => SHIPPED.test(name))) {
  if (/[#@]\s*sourceMappingURL=/.test(readFileSync(join(dist, f), 'utf-8'))) {
    fail(`${f} carries a sourceMappingURL — maps must be hidden, not referenced`)
  }
}

// 3 — the service worker precaches no map
const swPath = join(dist, 'sw.js')
if (!existsSync(swPath)) {
  fail('no sw.js in the build — cannot check the precache manifest')
} else {
  const precached = [...readFileSync(swPath, 'utf-8').matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1])
  if (precached.length === 0) fail('found no precache entries in sw.js — the manifest shape changed, fix this check')
  const leaked = precached.filter((url) => /\.map($|\?)/.test(url))
  if (leaked.length) fail(`sw.js precaches ${leaked.length} sourcemap(s): ${leaked.slice(0, 5).join(', ')}`)
}

if (failures.length) {
  console.error(`check-sourcemaps: ${failures.length} problem(s)\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`check-sourcemaps: OK — ${maps.length} hidden maps, entry ${entries.join(', ')} mapped, none referenced, none precached`)
