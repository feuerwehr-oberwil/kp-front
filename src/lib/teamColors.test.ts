// Two Trupps on one Lage sharing a colour is the failure this module exists to stop — see the
// header of teamColors.ts for how the old pair of counters produced it.

import { describe, expect, it } from 'vitest'
import { appConfig } from '../config/appConfig'
import { readFileSync } from 'node:fs'
import { pickTeamColor, shownTeamColor } from './teamColors'

const P = appConfig.drawing.teamColors

describe('pickTeamColor', () => {
  it('keeps the preferred colour when nothing else has it', () => {
    expect(pickTeamColor(P[3], [P[0], P[1]])).toBe(P[3])
  })

  it('steps aside when the preferred colour is already on the Lage', () => {
    const got = pickTeamColor(P[1], [P[0], P[1]])
    expect(got).not.toBe(P[1])
    expect(got).toBe(P[2])
  })

  it('gives a loose marker the first free colour, not a counter', () => {
    // the old bug: two markers placed after one deletion both landed on teamColors[1]
    expect(pickTeamColor(undefined, [P[0]])).toBe(P[1])
    expect(pickTeamColor(undefined, [P[0], P[1]])).toBe(P[2])
  })

  it('fills gaps left by a deleted Trupp instead of walking past them', () => {
    expect(pickTeamColor(undefined, [P[0], P[2], P[3]])).toBe(P[1])
  })

  it('ignores case and empty slots', () => {
    expect(pickTeamColor(undefined, [P[0].toUpperCase(), undefined, ''])).toBe(P[1])
  })

  it('wraps only once every colour is taken', () => {
    expect(pickTeamColor(P[4], P)).toBe(P[4])       // preferred wins the tie-break
    expect(P).toContain(pickTeamColor(undefined, P)) // …and a loose marker still gets a real colour
  })
})

// M4 (owner's pick A, 13.11.2026): a Trupp's identity never borrows a state colour
describe('the Trupp palette', () => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const hue = (hex: string) => {
    const [r, g, b] = rgb(hex), max = Math.max(r, g, b), d = max - Math.min(r, g, b)
    if (d === 0) return null
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }
  const nightSurface = /:root\[data-theme="night"\] \{[^}]*?--surface: (#[0-9a-f]{6})/i.exec(readFileSync('src/styles/01-tokens.css', 'utf8'))![1]

  it('holds no red, amber, lime or green hue', () => {
    for (const c of P) {
      const h = hue(c)
      // slate is a grey (its hue is a blue tint) – every other colour sits between cyan and pink
      expect(h === null || (h > 180 && h < 340), `${c} at ${h}°`).toBe(true)
    }
  })

  it('reads at 3:1 against white and the night surface', () => {
    for (const c of P) {
      expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(3)
      expect(contrast(c, nightSurface), c).toBeGreaterThanOrEqual(3)
    }
  })

  it('shows a stored retired hue in a stand-in the old palette did not wear, and leaves the rest', () => {
    const old = ['#1f6feb', '#8b5cf6', '#0891b2', '#db2777', '#475569']
    const standIns = ['#e8392b', '#1f9d57', '#e2920a'].map((c) => shownTeamColor(c.toUpperCase()))
    expect(new Set(standIns).size).toBe(3)
    for (const c of standIns) {
      expect(P).toContain(c)
      expect(old).not.toContain(c)
    }
    expect(shownTeamColor('#8b5cf6')).toBe('#8b5cf6')
    expect(shownTeamColor(undefined)).toBe(P[0])
  })

  it('counts a stored retired hue as its stand-in when it picks a free colour', () => {
    expect(pickTeamColor(shownTeamColor('#e8392b'), ['#e8392b'])).not.toBe(shownTeamColor('#e8392b'))
  })
})
