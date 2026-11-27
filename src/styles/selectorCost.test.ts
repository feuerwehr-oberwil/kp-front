// Selector shapes that make a slow phone restyle the whole page, held as a static count (perf
// sweep 27.11.2026). Measured in Chromium at 390×844, CPU ÷4: ONE rule of the shape
// «a `:has()` on an ancestor, over a subject with no class of its own» –
//   .modalStack.is-kb:has(.teamSearch input:focus) .stack > :not(:has(> .team))
// – turned every key typed into the Meldung composer into a recalc of ~890 elements (~30 ms),
// though no Trupp form was open. The same rule with a class on its subject (`.stack >
// .searchHides`) costs nothing measurable: Blink then restyles only the elements that carry it.
// A new rule of the shape fails here; name the subject by a class instead.
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** the top-level pieces of `s` split at any character in `seps`, outside (…) and […] */
function splitTop(s: string, seps: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (depth === 0 && seps.includes(ch)) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((p) => p.trim()).filter(Boolean)
}

/** Whether a compound selector names something Blink can key an invalidation on: a class, id,
 *  attribute or tag outside `:not()` / `:has()` (`:global()`, `:is()`, `:where()` count by
 *  their contents). */
function keyed(compound: string): boolean {
  let s = compound
  // drop the arguments of the pseudo-classes that do not key the subject; unwrap the rest
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '') }
  s = s.replace(/:(?:global|is|where|-webkit-any)\(/g, '(')
  return /[.#[]|^[a-z]/i.test(s.replace(/::?[a-z-]+(\([^()]*\))?/gi, ''))
}

/** Whether one complex selector has a `:has()` in a compound before its subject, and a subject
 *  that is not keyed. */
export function restylesWholePage(selector: string): boolean {
  const compounds = splitTop(selector.replace(/\s*([>+~])\s*/g, ' ').replace(/\s+/g, ' '), ' ')
  if (compounds.length < 2) return false
  const subject = compounds[compounds.length - 1]
  return compounds.slice(0, -1).some((c) => c.includes(':has(')) && !keyed(subject)
}

/** every complex selector of a stylesheet (comments and at-rule preludes left out) */
function selectors(raw: string): string[] {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{};]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((p) => p && !p.startsWith('@'))
    .flatMap((p) => splitTop(p, ','))
}

describe('restylesWholePage', () => {
  it('finds the shape the composer paid for, and only that', () => {
    expect(restylesWholePage('.modalStack:global(.is-kb):has(.teamSearch input:focus) .stack > :not(:has(> .team))')).toBe(true)
    expect(restylesWholePage('.stack:has(.teamSearch input:focus) > *')).toBe(true)
    expect(restylesWholePage('.a:has(.x)\n  .b > :not(.c)')).toBe(true) // a line break is a combinator too
    expect(restylesWholePage('.modalStack:global(.is-kb):has(.teamSearch input:focus) .stack > .searchHides')).toBe(false)
    expect(restylesWholePage('.modalStack:global(.is-kb):has(.teamSearch input:focus) .modalFoot')).toBe(false)
    expect(restylesWholePage(':root:has(.ml) .toaster')).toBe(false)
    expect(restylesWholePage('.wb:has(.x) :is(.a, .b)')).toBe(false)
    expect(restylesWholePage('.stack > :not(:has(> .team))')).toBe(false) // no :has() above the subject
  })
})

describe('no stylesheet restyles the whole page from a :has()', () => {
  it('has no rule of the shape', () => {
    const found = globSync('src/**/*.css', { cwd: process.cwd() }).sort()
      .flatMap((f) => selectors(readFileSync(f, 'utf8')).filter(restylesWholePage).map((s) => `${f}: ${s}`))
    expect(found).toEqual([])
  })
})
