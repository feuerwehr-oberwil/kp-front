// @vitest-environment jsdom
// The Gebäude chip on the Karte / in the plan's chip row (KP Front F5): closed it names the hazards
// as glyph + WORD, a tap opens the card above it, ✕ / the chip / Esc close it, nothing → no chip.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildingFloat } from './BuildingFloat'
import type { BuildingInfo } from '../lib/api/building'

afterEach(cleanup)

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
  it('closed: the hazards as warn glyph + words, and that there are Sofortmassnahmen', () => {
    render(<BuildingFloat info={base} />)
    const chip = screen.getByRole('button', { name: 'Gebäude: Gas, PV – Steckbrief öffnen' })
    expect(chip.textContent).toContain('Gebäude-Info · Gas · PV')
    expect(chip.textContent).toContain('Sofortmassn.')
    expect(chip.querySelector('use')?.getAttribute('href')).toBe('#warn')
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

  it('no hazard: «Gebäude-Info» with the info glyph (never the rail tile\'s word + storey glyph); compact: the glyph alone', () => {
    const calm = { ...base, gwr: { ...base.gwr!, heating: ['district'], hot_water: [] }, plants: [], object: null }
    render(<BuildingFloat info={calm} />)
    const chip = screen.getByRole('button', { name: 'Gebäude-Steckbrief öffnen' })
    expect(chip.textContent).toBe('Gebäude-Info')
    expect(chip.querySelector('use')?.getAttribute('href')).toBe('#info')
    cleanup()
    render(<BuildingFloat info={calm} compact />)
    expect(screen.getByRole('button', { name: 'Gebäude-Steckbrief öffnen' }).textContent).toBe('')
    cleanup()
    render(<BuildingFloat info={base} compact />)
    const compact = screen.getByRole('button', { name: /Steckbrief öffnen/ })
    expect(compact.textContent).toBe('Gas · PV')
    // the Sofortmassnahmen still say they are there — as the glyph
    expect([...compact.querySelectorAll('use')].map((u) => u.getAttribute('href'))).toEqual(['#warn', '#checklist'])
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
