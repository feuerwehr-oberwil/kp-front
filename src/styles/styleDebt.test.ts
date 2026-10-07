// THE stylesheet ratchet (07.10.2026, UI sweep C1–C5) — the CSS twin of eslint's --max-warnings.
// 01-tokens.css has the scales now (type, weight, space, elevation); the app's stylesheets still
// carry ~1000 literals from before them. They move onto the scales surface by surface
// (~/kp-front-wt/_sweep/system-migration-plan.md). Until then this test keeps the pile from
// GROWING: per file it counts
//   fontSize – a px size in `font-size:` or the `font:` shorthand        → var(--fs-*)
//   weight   – a font-weight that is no step (600, 650, 750, 300, …)      → var(--fw-*)
//   spacing  – a padding/margin/gap px value off the 4/8 grid (5, 7, 9…) → var(--sp-*)
//   shadow   – a box-shadow with a literal colour (rgba, #…)              → var(--e1…e5)
// and fails when a count goes UP, or a new file brings any. It also fails when a count goes
// DOWN and the baseline still has the old number, the way the lint ceiling is lowered by hand:
//   STYLE_DEBT_UPDATE=1 pnpm vitest run src/styles/styleDebt.test.ts
// rewrites styleDebt.baseline.json — but only ever lowers it. There is no command that raises it;
// if a literal is genuinely right, say why in the file and edit the JSON in the same commit.
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Metric = 'fontSize' | 'weight' | 'spacing' | 'shadow'
type Counts = Partial<Record<Metric, number>>
const METRICS: Metric[] = ['fontSize', 'weight', 'spacing', 'shadow']
const BASELINE = 'src/styles/styleDebt.baseline.json'

/** the grid --sp-* is built on; 0–2px are optical nudges (a hairline, a baseline), not spacing */
const ON_GRID = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64])
const WEIGHTS = new Set(['400', '500', '700', '800', 'normal', 'bold', 'inherit'])

const decls = (css: string, prop: RegExp) =>
  [...css.matchAll(new RegExp(`(?:^|[;{\\s])(${prop.source})\\s*:\\s*([^;{}]+)`, 'g'))].map(m => m[2])

export function countDebt(raw: string): Counts {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const fontSize = decls(css, /font-size/).filter(v => /\d(?:\.\d+)?px/.test(v)).length
    + decls(css, /font/).filter(v => /(?:^|\s)\d+(?:\.\d+)?px/.test(v)).length
  const weight = decls(css, /font-weight/).filter(v => !WEIGHTS.has(v.trim()) && !v.includes('var(')).length
    + decls(css, /font/).filter(v => {
      const w = /^\s*(\d{3})\s/.exec(v)
      return !!w && !WEIGHTS.has(w[1])
    }).length
  const spacing = decls(css, /(?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap/)
    .flatMap(v => [...v.matchAll(/(-?\d*\.?\d+)px/g)].map(m => Math.abs(parseFloat(m[1]))))
    .filter(n => !ON_GRID.has(n)).length
  const shadow = decls(css, /box-shadow/).filter(v => /rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/i.test(v)).length
  const out: Counts = {}
  for (const [k, n] of Object.entries({ fontSize, weight, spacing, shadow }) as [Metric, number][]) if (n) out[k] = n
  return out
}

// 01-tokens.css is where the literals are SUPPOSED to live
const files = globSync('src/**/*.css', { cwd: process.cwd() }).filter(f => !f.endsWith('01-tokens.css')).sort()
const current: Record<string, Counts> = Object.fromEntries(
  files.map(f => [f, countDebt(readFileSync(f, 'utf8'))] as const).filter(([, c]) => Object.keys(c).length))
// a MISSING baseline is the one state the update writes from scratch (shows up whole in the diff)
const fresh = !existsSync(BASELINE)
const baseline: Record<string, Counts> = fresh ? {} : JSON.parse(readFileSync(BASELINE, 'utf8'))

describe('stylesheet debt ratchet', () => {
  it('counts what it says', () => {
    expect(countDebt(`
      /* font-size: 99px; box-shadow: 0 0 1px #000 */
      .a { font-size: 13px; font: 700 12px/1.3 var(--body); font-size: var(--fs-2); font: inherit }
      .b { font-weight: 600; font: 650 14px var(--body); font-weight: 700; font-weight: var(--fw-bold) }
      .c { padding: 7px 8px 2px; margin: -5px 0; gap: var(--sp-2) 12px; margin-top: 10px }
      .d { box-shadow: 0 1px 2px rgba(0, 0, 0, .3); box-shadow: var(--e2); box-shadow: inset 0 0 0 1px #fff }
    `)).toEqual({ fontSize: 3, weight: 2, spacing: 3, shadow: 2 })
  })

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('no stylesheet has more literals than its baseline', () => {
    if (process.env.STYLE_DEBT_UPDATE === '1') {
      // lower only: a file keeps the smaller of its two counts per metric, a cleared file drops out
      const next: Record<string, Counts> = {}
      for (const f of Object.keys(current).sort()) {
        const c: Counts = {}
        for (const m of METRICS) {
          const n = fresh ? current[f][m] ?? 0 : Math.min(current[f][m] ?? 0, baseline[f]?.[m] ?? 0)
          if (n) c[m] = n
        }
        if (Object.keys(c).length) next[f] = c
      }
      writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
      for (const f of Object.keys(baseline)) delete baseline[f]
      Object.assign(baseline, next)
    }
    const up: string[] = []
    for (const [f, c] of Object.entries(current)) {
      for (const m of METRICS) {
        const was = baseline[f]?.[m] ?? 0
        if ((c[m] ?? 0) > was) up.push(`${f}: ${m} ${was} → ${c[m]}`)
      }
    }
    expect(up, 'new literal(s): use the tokens in 01-tokens.css (--fs-*, --fw-*, --sp-*, --e*)').toEqual([])
  })

  it('the baseline is as low as the stylesheets', () => {
    const down: string[] = []
    for (const [f, c] of Object.entries(baseline)) {
      for (const m of METRICS) {
        const now = current[f]?.[m] ?? 0
        if ((c[m] ?? 0) > now) down.push(`${f}: ${m} ${c[m]} → ${now}`)
      }
    }
    expect(down, 'debt went down — lower the baseline: STYLE_DEBT_UPDATE=1 pnpm vitest run src/styles/styleDebt.test.ts').toEqual([])
  })
})
