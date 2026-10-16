// @vitest-environment jsdom
// «Karte & Objekte» — the one panel: the capture door only for capture roles, a register hint
// that says where it came from, «In der Nähe» with its disclaimer, and missing data said, never
// read as «no hazard». Synthetic Musterdorf data only.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KartePanel, type RegisterState } from './KartePanel'
import type { StationObject } from '../../lib/api/stationReference'
import type { BuildingInfo } from '../../lib/api/building'

afterEach(cleanup)

const SCHLOSS: StationObject = {
  id: 'schloss', name: 'Schloss Musterdorf', kind: 'einsatzobjekt', address: 'Schlossgasse 9, 9999 Musterdorf',
  lat: 47.523773, lng: 7.570188, aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null,
  measures: 'Zufahrt nur über Schlossgasse', measuresSource: 'Modul 1 · Stand 03.2026',
}
const INFO: BuildingInfo = {
  registers: 'on', egid: '1', address: 'Schlossgasse 9, 9999 Musterdorf',
  gwr: { stand: '2026-10-07', floors: 3, flats: null, year: 1650, period: null, heating: ['gas'], heating_date: null, hot_water: [], shelter: null, status: null },
  gwr_status: 'ok', plants: [], pv_status: 'ok', registers_fetched_at: '2026-10-16T10:00:00Z', object: null, visit: null,
}
const ok: RegisterState = { state: 'ok', info: INFO, cached: false }

const panel = (over: Partial<Parameters<typeof KartePanel>[0]> = {}) => render(
  <KartePanel
    sel={{ kind: 'object', obj: SCHLOSS }} register={ok} nearby={[]} hydrants={[]} visits={{ state: 'ok', list: [] }}
    canCapture docs={[]} georefOn={false} georefAvailable={false} sheet={false} full={false} withRail={false}
    onToggleFull={vi.fn()} onClose={vi.fn()} onMeasureHere={vi.fn()} onStartVisit={vi.fn()} onOpenDoc={vi.fn()}
    onToggleGeoref={vi.fn()} onSelectObject={vi.fn()} onRetryRegister={vi.fn()} onOpenVisit={vi.fn()}
    onPinBuilding={vi.fn()} onCopyCoords={vi.fn()} {...over}
  />,
)

describe('KartePanel', () => {
  it('shows the station word with its source, then the register as a hint', () => {
    panel()
    expect(screen.getByText('Zufahrt nur über Schlossgasse')).toBeTruthy()
    expect(screen.getByText('Station · Modul 1 · Stand 03.2026')).toBeTruthy()
    expect(screen.getByText('Register-Hinweis')).toBeTruthy()
    expect(screen.getByText('Heizung Gas')).toBeTruthy()
    expect(screen.getByText(/GWR Schlossgasse 9 · Stand 07.10.2026/)).toBeTruthy()
    // the disclaimer under «In der Nähe» stands even with nothing near
    expect(screen.getByText(/Ein Objekt in der Nähe gehört nicht unbedingt zu diesem Gebäude/)).toBeTruthy()
  })

  it('draws the capture door only for a capture role, and says why otherwise', () => {
    panel()
    expect(screen.getByRole('button', { name: /Objektbesuch/ })).toBeTruthy()
    cleanup()
    panel({ canCapture: false })
    expect(screen.queryByRole('button', { name: /Objektbesuch/ })).toBeNull()
    expect(screen.getByText('Mit diesem Konto kannst du Besuche lesen, aber nicht erfassen.')).toBeTruthy()
  })

  it('says what is missing instead of drawing nothing', () => {
    panel({ sel: { kind: 'object', obj: { ...SCHLOSS, measures: null, measuresSource: null } }, register: { state: 'offline', info: null, cached: false } })
    expect(screen.getByText('Registerangaben für diesen Ort sind nicht auf diesem Gerät gespeichert.')).toBeTruthy()
    expect(screen.getByText('Keine Gefahrenangaben der Station erfasst. Das heisst nicht, dass es keine gibt.')).toBeTruthy()
  })

  it('names a register entry at another address as exactly that', () => {
    panel({ register: { state: 'ok', info: { ...INFO, address: 'Schlossgasse 11, 9999 Musterdorf' }, cached: true } })
    expect(screen.getByText('Registereintrag Schlossgasse 11, nicht Schlossgasse 9')).toBeTruthy()
  })

  it('offers a pin «Meldung erfassen» and the coordinates', () => {
    panel({ sel: { kind: 'pin', at: [7.57175, 47.52015], near: { label: 'Starenstrasse 19', distanceM: null }, nearState: 'ok', onBuilding: false } })
    expect(screen.getByText('bei Starenstrasse 19')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Meldung erfassen/ })).toBeTruthy()
    expect(screen.getByText(/LV95/)).toBeTruthy()
  })
})
