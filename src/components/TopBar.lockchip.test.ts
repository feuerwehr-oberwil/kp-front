import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Staging r4: on a phone the «Einsatz abgeschlossen» lock chip is 32×26 px in the bar — and it is
// the only door to «Wieder öffnen». Its TAP area is the house 44 px (AGENTS.md · touch targets),
// grown invisibly around the glyph so the bar does not reflow. Pinned in the phone block's CSS.
describe('the phone lock chip', () => {
  const css = readFileSync(`${process.cwd()}/src/styles/10-journal.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const phone = css.slice(css.indexOf('.tb-mode { padding: 5px 8px; font-size: 0; gap: 0; }'))
  it('has a ≥44 px hit area on the button', () => {
    const rule = /button\.tb-mode::after\s*\{([^}]*)\}/.exec(phone)?.[1] ?? ''
    expect(rule).toMatch(/width:\s*max\(100%,\s*44px\)/)
    expect(rule).toMatch(/height:\s*max\(100%,\s*44px\)/)
    expect(/button\.tb-mode\s*\{\s*position:\s*relative;/.test(phone)).toBe(true)
  })
})
