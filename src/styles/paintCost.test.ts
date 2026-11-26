// Paint costs a slow device pays for every frame, held as static counts (perf sweep 26.11.2026 –
// CI has no GPU, so the stylesheet is the only place these can be checked):
//   · the floating blur lives in ONE token, and the night theme turns it off (its glass is 97 %
//     opaque, the blur showed through at 3 %);
//   · the Plan's open-drawing dashes step at the Karte's cadence (lib/draftAnts), not at 60 Hz.
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DRAFT_ANTS, DRAFT_ANTS_STEP, DRAFT_ANTS_TICK_MS } from '../lib/draftAnts'

const read = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const sheets = globSync('src/**/*.css', { cwd: process.cwd() }).sort()
/** the declarations of the first rule whose selector is exactly `selector` */
const ruleBody = (css: string, selector: string) =>
  [...css.matchAll(/([^{};]*)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector)?.[2] ?? ''

describe('the floating blur is one token', () => {
  it('no stylesheet spells out the token’s value', () => {
    const copies = sheets.flatMap((f) =>
      [...read(f).matchAll(/backdrop-filter\s*:\s*blur\(14px\) saturate\(1\.4\)/g)].map(() => f))
    expect(copies).toEqual([])
  })

  it('the night theme turns it off', () => {
    const night = ruleBody(read('src/styles/01-tokens.css'), ':root[data-theme="night"]')
    expect(night).toMatch(/--float-blur:\s*none\s*;/)
  })
})

describe('the Plan’s open dashes step like the Karte’s', () => {
  const css = read('src/styles/09-whiteboard.css')
  const anim = /animation:\s*wb-ants\s+([\d.]+)(m?s)\s+([^;]+);/.exec(ruleBody(css, '.wb-draft-open'))

  it('steps, one step per Karte tick', () => {
    expect(anim).not.toBeNull()
    const [, n, unit, rest] = anim!
    const steps = /steps\((\d+)\)/.exec(rest)
    expect(steps, `timing «${rest}»`).not.toBeNull()
    const stepMs = (Number(n) * (unit === 's' ? 1000 : 1)) / Number(steps![1])
    expect(Math.abs(stepMs - DRAFT_ANTS_TICK_MS)).toBeLessThanOrEqual(10)
  })

  it('advances the Karte’s share of a dash period per step', () => {
    const steps = Number(/steps\((\d+)\)/.exec(anim?.[3] ?? '')?.[1])
    const offset = Math.abs(Number(/@keyframes wb-ants\s*\{\s*to\s*\{\s*stroke-dashoffset:\s*(-?[\d.]+)/.exec(css)?.[1]))
    const period = (ruleBody(css, '.wb-draft-open').match(/stroke-dasharray:\s*([\d.]+)\s+([\d.]+)/) ?? [])
      .slice(1).reduce((a, b) => a + Number(b), 0)
    expect(offset / steps / period).toBeCloseTo(DRAFT_ANTS_STEP / DRAFT_ANTS.length, 5)
  })

  it('stands still while the ink layer is held (WbControls.test · the class)', () => {
    expect(ruleBody(css, '.wb-ink-svg.held .wb-draft-open')).toMatch(/animation-play-state:\s*paused/)
  })
})
