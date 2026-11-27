// @vitest-environment jsdom
// The Gebäude chip on the Karte / in the plan's chip row (KP Front F5): closed it names the hazards
// as glyph + WORD, a tap opens the card above it, ✕ / the chip / Esc close it, nothing → no chip.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubMatchMedia } from '../test/dom.test-utils'
import { BuildingFloat } from './BuildingFloat'
import { loadPrefs, savePrefs } from '../lib/prefs'
import type { BuildingInfo } from '../lib/api/building'

afterEach(() => {
  cleanup(); vi.unstubAllGlobals()
  savePrefs({ ...loadPrefs(), railLabels: undefined, railLabelsChosen: undefined })
})

/** every media query matches — useIsPhone reads a phone */
const asPhone = () => stubMatchMedia(() => true)

const base: BuildingInfo = {
  registers: 'on', egid: '409428', address: 'Mühlemattstrasse 18, 4104 Oberwil',
  gwr: { stand: '2026-10-07', floors: 3, flats: 1, year: 1965, period: null, heating: ['gas'], heating_date: '2022-06-29', hot_water: ['gas'], shelter: null, status: null },
  gwr_status: 'ok',
  plants: [{ kind: 'pv', label: 'Photovoltaik', power_kw: 35.6, since: '2024-06-21' }],
  pv_status: 'ok', registers_fetched_at: null,
  object: { id: 'o', name: 'Gewerbehaus', address_match: true, distance_m: 0, measures: 'Gashaupthahn schliessen', remarks: null, measures_source: 'Modul 1', updated_at: null },
  visit: null,
}

describe('BuildingFloat', () => {
  // one action (owner, 09.11.2026): one glyph, one label, the Sofortmassnahmen as a count badge
  it('closed: the hazards as warn glyph + words, and how many Sofortmassnahmen – one glyph only', () => {
    render(<BuildingFloat info={{ ...base, object: { ...base.object!, measures: 'Gashaupthahn schliessen\nEW-Pikett aufbieten' } }} />)
    const chip = screen.getByRole('button', { name: 'Gebäude: Gas, PV – Steckbrief öffnen · 2 Sofortmassnahmen' })
    expect(chip.textContent).toBe('Gebäude-Info · Gas · PV2')
    expect([...chip.querySelectorAll('use')].map((u) => u.getAttribute('href'))).toEqual(['#warn'])
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a tap opens the card; ✕, the chip and Esc close it', () => {
    render(<BuildingFloat info={base} />)
    const chip = screen.getByRole('button', { name: /Steckbrief öffnen/ })
    fireEvent.click(chip)
    expect(screen.getByRole('dialog', { name: 'Gebäude' })).toBeTruthy()
    expect(screen.getByText('Gashaupthahn schliessen')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Schliessen' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(chip)
    fireEvent.click(chip)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(chip)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // owner pick M4 B (18.11.2026): open reads as a pressed tile – lit; no chevron, open or closed
  // (owner, 18.11.2026 evening: «drop the chevron»)
  it('open: the chip is lit, the count goes, and no chevron appears', () => {
    asPhone()
    render(<BuildingFloat info={base} />)
    const chip = screen.getByRole('button', { name: /Steckbrief öffnen/ })
    const glyphs = () => [...chip.querySelectorAll('use')].map((u) => u.getAttribute('href'))
    expect(glyphs()).toEqual(['#warn'])
    expect(chip.textContent).toContain('1')
    fireEvent.click(chip)
    expect(chip.classList.contains('arm')).toBe(true)
    expect(glyphs()).toEqual(['#warn'])
    expect(chip.textContent).toBe('Gas · PV')
    fireEvent.click(chip)
    expect(chip.classList.contains('arm')).toBe(false)
    expect(glyphs()).toEqual(['#warn'])
  })

  // owner pick C8 (05.11.2026): «Gebäude-Info» on every surface
  it('no hazard: «Gebäude-Info» with the info glyph (never the rail tile\'s word + storey glyph)', () => {
    const calm = { ...base, gwr: { ...base.gwr!, heating: ['district'], hot_water: [] }, plants: [], object: null }
    render(<BuildingFloat info={calm} />)
    const chip = screen.getByRole('button', { name: 'Gebäude-Steckbrief öffnen' })
    expect(chip.textContent).toBe('Gebäude-Info')
    expect(chip.querySelector('use')?.getAttribute('href')).toBe('#info')
  })

  // button round 17.11.2026, owner pick 12C: on a phone ONE tile shape, whatever it says – «Info»
  // quiet or with a hand entry, the hazard words with one; the count and the full label stay
  it('phone: always the tile – (i) «Info» or ⚠ + the hazard words; the count and the full label stay', () => {
    asPhone()
    render(<BuildingFloat info={base} />)
    const chip = screen.getByRole('button', { name: 'Gebäude: Gas, PV – Steckbrief öffnen · 1 Sofortmassnahme' })
    expect(chip.textContent).toBe('Gas · PV1')
    expect(chip.classList.contains('wb-tile')).toBe(true)
    expect(chip.getAttribute('title')).toBe(chip.getAttribute('aria-label'))
    cleanup()
    const calmGwr = { ...base.gwr!, heating: ['district'], hot_water: [] }
    render(<BuildingFloat info={{ ...base, gwr: calmGwr, plants: [], object: { ...base.object!, measures: null, remarks: 'Schlüssel beim Hauswart' } }} />)
    const noted = screen.getByRole('button', { name: 'Gebäude-Steckbrief öffnen' })
    expect(noted.textContent).toBe('Info')
    expect(noted.classList.contains('wb-tile')).toBe(true)
    expect(noted.querySelector('use')?.getAttribute('href')).toBe('#info')
  })

  // Üben feedback (owner 27.11.2026): «Beschriftung der Werkzeugleisten: Aus» takes the chip's word
  // like the bars' – the hazard words are the fact and stay; the full label stays the name
  it('words off: the glyph alone, or ⚠ + the hazard words – on a tablet and a phone', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    const calm = { ...base, gwr: { ...base.gwr!, heating: ['district'], hot_water: [] }, plants: [], object: { ...base.object!, measures: null, remarks: 'Schlüssel beim Hauswart' } }
    for (const phone of [false, true]) {
      if (phone) asPhone()
      render(<BuildingFloat info={calm} />)
      const bare = screen.getByRole('button', { name: 'Gebäude-Steckbrief öffnen' })
      expect(bare.textContent).toBe('')
      // a bare panel door: a hold names it and opens nothing (lib/holdTooltip · data-holdname)
      expect(bare.hasAttribute('data-holdname')).toBe(true)
      cleanup()
      render(<BuildingFloat info={base} />)
      const hazard = screen.getByRole('button', { name: 'Gebäude: Gas, PV – Steckbrief öffnen · 1 Sofortmassnahme' })
      expect(hazard.textContent).toBe('Gas · PV1')
      expect(hazard.hasAttribute('data-holdname')).toBe(false) // its words answer
      cleanup()
    }
  })

  it('autoOpen (the first open, lib/buildingFirstOpen) opens the card by itself; any close marks it read', () => {
    const reads: string[] = []
    const { rerender } = render(<BuildingFloat info={base} autoOpen={false} onRead={() => reads.push('read')} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<BuildingFloat info={base} autoOpen onRead={() => reads.push('read')} />)
    expect(screen.getByRole('dialog', { name: 'Gebäude' })).toBeTruthy()
    // non-modal: the chip is still there to close it, nothing traps focus
    expect(screen.getByRole('button', { name: /Steckbrief öffnen/ }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Schliessen' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reads).toEqual(['read'])
    // the chip reopens it; Esc and the chip are a close too
    const chip = screen.getByRole('button', { name: /Steckbrief öffnen/ })
    fireEvent.click(chip)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(chip)
    fireEvent.click(chip)
    expect(reads).toEqual(['read', 'read', 'read'])
  })

  // owner, 27.10.2026: «a clear two-step thing: first "Sofortmassnahmen" then "Gebäude"» – the
  // hazards lead the Gebäude section, no longer the card
  it('Sofortmassnahmen first, then Gebäude with its hazards ahead of the facts', () => {
    render(<BuildingFloat info={{ ...base, object: { ...base.object!, remarks: 'Schlüsseldepot beim Haupttor' } }} autoOpen />)
    const text = screen.getByRole('dialog').textContent ?? ''
    const at = (t: string) => text.indexOf(t)
    expect(at('Heizung Gas')).toBeGreaterThan(-1)
    expect(at('Gashaupthahn schliessen')).toBeLessThan(at('Bemerkungen'))
    expect(at('Schlüsseldepot beim Haupttor')).toBeLessThan(at('Gebäude'))
    expect(at('Gebäude')).toBeLessThan(at('Heizung Gas'))
    expect(at('PV 35.6 kW')).toBeLessThan(at('3 Geschosse'))
    expect(at('Heizung Gas')).toBeLessThan(at('3 Geschosse'))
    // the source line stands under «Register-Hinweis», folded on every open (09.11.2026) and,
    // opened, after what must be read
    expect(at('GWR')).toBe(-1)
    fireEvent.click(screen.getByRole('button', { name: /Register-Hinweis/ }))
    const opened = screen.getByRole('dialog').textContent ?? ''
    expect(opened.indexOf('Sofortmassnahmen')).toBeLessThan(opened.indexOf('GWR'))
  })

  it('nothing to say → no chip at all', () => {
    const { container } = render(<BuildingFloat info={{ ...base, gwr: null, gwr_status: 'error', plants: [], pv_status: 'skipped', object: null }} />)
    expect(container.innerHTML).toBe('')
    const { container: none } = render(<BuildingFloat info={null} />)
    expect(none.innerHTML).toBe('')
  })
})

// Every `s.<name>` the chip reads has a rule in its module. Vitest hands a CSS module back as a
// proxy that answers ANY name, so only the source can show it: on main the chip printed
// `class="wb-scale-chip undefined"` off an `s.chip` the stylesheet never had (10.10.2026).
it('BuildingFloat reads only classes its module defines', () => {
  const read = (f: string) => readFileSync(`${process.cwd()}/src/components/${f}`, 'utf8')
  const used = new Set([...read('BuildingFloat.tsx').matchAll(/\bs\.([a-zA-Z]\w*)/g)].map((m) => m[1]))
  const css = read('BuildingFloat.module.css')
  expect([...used].filter((n) => !new RegExp(`\\.${n}\\b`).test(css))).toEqual([])
})
