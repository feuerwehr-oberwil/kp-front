// @vitest-environment jsdom
// The detail panel (.ctx – the symbol panel, the Linien-/Flächen-/Form-Editor) is 360px wide on a
// tablet as on a laptop: its label column (--ctx-lbl) and control edge need the whole width. A
// tablet rule narrowed it to clamp(300px, 100vw − 420px, 360px); at 720px wide (300px) the
// Linienende's four segments broke 2 × 2 and the «Text» field cut its placeholder (owner, Üben
// feedback 27.11.2026). jsdom applies no @media, so this reads the rules under each query.
import { expect, it } from 'vitest'
import { addStyles, appStylesheets } from '../test/dom.test-utils'

it('gives .ctx one width, 360px, under every query but the phone bottom sheet', () => {
  const widths: string[] = []
  const walk = (rules: CSSRuleList, media: string) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, rule.conditionText)
      else if (rule instanceof CSSStyleRule && rule.selectorText.split(',').some((s) => s.trim() === '.ctx') && rule.style.width)
        widths.push(`${media || 'all'} → ${rule.style.width}`)
    }
  }
  const sheets = addStyles(...appStylesheets())
  for (const sheet of sheets) walk(sheet.cssRules, '')
  for (const s of sheets) s.ownerNode?.remove()
  expect(widths.filter((w) => !w.startsWith('(--phone)'))).toEqual(['all → 360px'])
})
