// Paint costs a slow device pays for every frame, held as static counts (perf sweep 26.11.2026 –
// CI has no GPU, so the stylesheet is the only place these can be checked):
//   · the floating blur lives in ONE token, and both themes turn it off over an opaque glass: the
//     night glass is 97 % (the blur showed through at 3 %), the day glass is solid (owner pick,
//     27.11.2026 – no blur, no map labels ghosting through the bars), and no sheet, dialog or card
//     on that glass spells out a blur of its own (only the see-through scrims and heads may);
//   · the Plan's open-drawing dashes step at the Karte's cadence (lib/draftAnts), not at 60 Hz;
//   · the Karte's «Einsatz läuft» dot pulses a few times, never forever, inside the blurred bar.
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

  // The only literal blurs left: each sits on a see-through background in a theme, so it shows.
  // Anything else routes through --float-blur (an opaque surface hides its blur and still pays
  // for it on every frame behind it).
  const VISIBLE_BLURS: Record<string, string> = {
    'src/styles/13-incident.css · .ui-backdrop, .modal-backdrop, .mp-backdrop, .help-scrim': 'the modal scrim, .32',
    'src/styles/13-incident.css · .ip-ovl': 'the sheets’ own scrim, .32',
    'src/styles/08-toasts.css · .photo-scrim': 'the photo viewer’s dark room, .72',
    'src/styles/13-incident.css · .cv-head': 'the capture view’s sticky head, --surface at 88 %',
    'src/styles/13-incident.css · .cv-acc-head': 'the capture view’s sticky section head, --surface at 88 %',
  }

  it('a literal blur stands only on a see-through background', () => {
    const blurs = sheets.flatMap((f) =>
      [...read(f).matchAll(/([^{};]*)\{([^{}]*)\}/g)]
        .filter((m) => /backdrop-filter\s*:\s*blur\(/.test(m[2]))
        .map((m) => `${f} · ${m[1].trim().replace(/\s+/g, ' ')}`))
    expect(blurs.filter((b) => !(b in VISIBLE_BLURS))).toEqual([])
    expect(Object.keys(VISIBLE_BLURS).filter((b) => !blurs.includes(b))).toEqual([])
  })

  it('the night theme turns it off', () => {
    const night = ruleBody(read('src/styles/01-tokens.css'), ':root[data-theme="night"]')
    expect(night).toMatch(/--float-blur:\s*none\s*;/)
  })

  const day = ruleBody(read('src/styles/01-tokens.css'), ':root')
  /** a day token's value, following var() chains inside the day block */
  const dayValue = (token: string): string => {
    const raw = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(day)?.[1].trim() ?? ''
    const ref = /^var\((--[\w-]+)\)$/.exec(raw)
    return ref ? dayValue(ref[1]) : raw
  }

  it('the day theme turns it off', () => {
    expect(dayValue('--float-blur')).toBe('none')
  })

  it('the day glass is solid, so nothing shows through the unblurred bars', () => {
    const glass = dayValue('--glass')
    const alpha = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(glass)?.[1]
    expect(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(glass) || alpha === '1', `--glass: ${glass}`).toBe(true)
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

describe('the «Einsatz läuft» dot', () => {
  const css = read('src/components/karte/Karte.module.css')
  const pulse = ruleBody(css, '.pulse')

  it('pulses a bounded number of times', () => {
    expect(pulse).toMatch(/animation:\s*koPulse\b/)
    expect(pulse).not.toMatch(/infinite/)
  })

  it('rests fully visible: no fill mode holds a dim frame, and the ends stay at the base', () => {
    expect(pulse).not.toMatch(/\b(forwards|both)\b/)
    const frames = /@keyframes koPulse\s*\{([\s\S]*?\})\s*\}/.exec(css)?.[1] ?? ''
    expect(frames).toMatch(/opacity/)
    expect(frames).not.toMatch(/(?:^|[\s,])(?:from|to|0%|100%)\s*[{,]/)
  })
})
