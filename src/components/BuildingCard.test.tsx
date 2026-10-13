// @vitest-environment jsdom
// The Gebäude card (KP Front F5): a hazard is the warn glyph AND its word, the Modul-1 notes are
// text, and a card with nothing to say is not drawn at all.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildingCard } from './BuildingCard'
import type { BuildingInfo } from '../lib/api/building'

afterEach(cleanup)

const base: BuildingInfo = {
  registers: 'on', egid: '408319', address: 'Hauptstrasse 10, 4104 Oberwil',
  gwr: { stand: '2026-10-07', floors: 2, flats: 2, year: 1926, period: null, heating: ['gas'], heating_date: '2022-06-29', hot_water: [], shelter: null, status: null },
  gwr_status: 'ok', plants: [], pv_status: 'ok', registers_fetched_at: null, object: null, visit: null,
}

describe('BuildingCard', () => {
  it('a hazard carries the warn glyph beside its word', () => {
    render(<BuildingCard info={base} />)
    const gas = screen.getByText('Heizung Gas').closest('li')!
    expect(gas.querySelector('use')?.getAttribute('href')).toBe('#warn')
    expect(screen.getByText('2 Geschosse').closest('li')!.querySelector('use')).toBeNull()
    expect(screen.getByText('Register-Hinweis')).toBeTruthy()
  })

  it('shows the Sofortmassnahmen as lines, with whose they are', () => {
    render(<BuildingCard info={{ ...base, object: { id: 'o', name: 'Schloss Musterdorf', address_match: true, distance_m: 0, measures: 'Prinzessin befreien\nTor öffnen', remarks: null, measures_source: 'Modul 1', updated_at: null } }} />)
    expect(screen.getByText('Sofortmassnahmen')).toBeTruthy()
    expect(screen.getByText('Tor öffnen').tagName).toBe('LI')
    expect(screen.getByText('Schloss Musterdorf · Modul 1')).toBeTruthy()
    expect(screen.queryByText('Bemerkungen')).toBeNull()
  })

  it('draws nothing when there is nothing to say', () => {
    const { container } = render(<BuildingCard info={{ ...base, gwr: null, gwr_status: 'error' }} />)
    expect(container.innerHTML).toBe('')
    const { container: none } = render(<BuildingCard info={null} />)
    expect(none.innerHTML).toBe('')
  })
})
