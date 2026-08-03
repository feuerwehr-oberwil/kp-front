import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// Every backend router is mounted under the `/api` prefix (backend/app/main.py), so every
// path handed to an api* helper must start with it. Nothing enforced that: the 2026-07-29
// move of the Overpass call onto our own backend (607a159, a privacy fix) shipped
// `apiPost('/overpass/buildings')` without the prefix. The SPA fallback answers that path
// with the index document, so the browser got a 405 rather than an error anyone would
// notice — building outlines were simply gone from the map and plan for five days, with no
// failing test and nothing in the logs.
//
// Scanning the source is deliberate: the bug lives in the call site's string literal, so a
// runtime test would have to exercise every caller to find it.

const SRC = join(__dirname, '..')
const CALL = /\bapi(?:Get|Post|Put|Patch|Delete)\s*(?:<[^(]*>)?\(\s*'([^']*)'/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
    return [p]
  })
}

describe('api helper call paths', () => {
  it('every literal path starts with /api/', () => {
    const offenders: string[] = []
    let seen = 0
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(CALL)) {
        seen++
        if (!m[1].startsWith('/api/')) offenders.push(`${file.slice(SRC.length + 1)}: '${m[1]}'`)
      }
    }
    // guard the guard: a regex that silently stops matching would make this pass forever
    expect(seen).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
