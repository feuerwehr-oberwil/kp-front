// @vitest-environment jsdom
// «Karte & Objekte» — the one panel: the capture door only for capture roles, a register hint
// that says where it came from, «In der Nähe» with its disclaimer, and missing data said, never
// read as «no hazard». Synthetic Musterdorf data only.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KartePanel, type RegisterState } from './KartePanel'
import type { StationObject } from '../../lib/api/stationReference'
import type { BuildingInfo } from '../../lib/api/building'
import type { ViewerPlanDoc } from '../../lib/karte/plans'

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
    onFull={vi.fn()} onClose={vi.fn()} onMeasureHere={vi.fn()} onStartVisit={vi.fn()} onOpenDoc={vi.fn()}
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

  // owner-5 (17.10.2026): a tapped building whose address is still being looked up read
  // «Gebäude» / «…» — the head is skeleton bars until the register answers, then the address
  it('shows a skeleton head, not «Gebäude», while a tapped building is looked up', () => {
    const loading: RegisterState = { state: 'loading', info: null, cached: false }
    panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: null }, register: loading })
    expect(screen.getByTestId('karte-head-loading')).toBeTruthy()
    expect(screen.getByText('Adresse wird gesucht …')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByText('…')).toBeNull()
    cleanup()
    panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: null }, register: ok })
    expect(screen.queryByTestId('karte-head-loading')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Schlossgasse 9' })).toBeTruthy()
    expect(screen.getByText('9999 Musterdorf')).toBeTruthy()
  })

  it('names a searched address at once, without waiting for the register', () => {
    panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: 'Schlossgasse 9, 9999 Musterdorf' }, register: { state: 'loading', info: null, cached: false } })
    expect(screen.queryByTestId('karte-head-loading')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Schlossgasse 9' })).toBeTruthy()
  })

  it('shows a skeleton head while a dropped pin is looked up, with its coordinates', () => {
    panel({ sel: { kind: 'pin', at: [7.57175, 47.52015], near: null, nearState: 'loading', onBuilding: false } })
    expect(screen.getByTestId('karte-head-loading')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText(/LV95/)).toBeTruthy()
  })

  // owner-4: no boxed «Kein Stationsobjekt an dieser Adresse» — but missing still is not «safe»
  it('keeps the building quiet: no box, the closing sentence stays', () => {
    panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: null } })
    expect(screen.queryByText(/Kein Stationsobjekt an dieser Adresse/)).toBeNull()
    expect(screen.getByText('Keine Gefahrenangaben der Station erfasst. Das heisst nicht, dass es keine gibt.')).toBeTruthy()
  })
})

describe('KartePanel · the phone sheet', () => {
  const PLAN = { id: 'plan:schloss:modul1', module: 'modul1', code: '1', title: 'Schloss – Übersicht', pages: 2, georef: false, version: 1, updatedAt: null }
  const DOCS = [{ doc: { id: 'd1', code: '1', title: 'Schloss – Übersicht', imageUrl: '/x.pdf' }, plan: PLAN }] as unknown as ViewerPlanDoc[]
  const WITH_PLANS = { ...SCHLOSS, plans: [PLAN] } as unknown as StationObject

  it('lists the plans right under the actions, before the station word', () => {
    const { container } = panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS, sheet: true })
    const text = container.textContent ?? ''
    expect(text.indexOf('Schloss – Übersicht')).toBeGreaterThan(text.indexOf('Messen ab hier'))
    expect(text.indexOf('Schloss – Übersicht')).toBeLessThan(text.indexOf('Sofortmassnahmen'))
    cleanup()
    // the tablet keeps its order (the plans are in its rail as well)
    const tab = panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS })
    const t2 = tab.container.textContent ?? ''
    expect(t2.indexOf('Schloss – Übersicht')).toBeGreaterThan(t2.indexOf('Sofortmassnahmen'))
  })

  it('opens a plan from its row', () => {
    const onOpenDoc = vi.fn()
    panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS, sheet: true, onOpenDoc })
    fireEvent.click(screen.getByRole('button', { name: /Schloss – Übersicht/ }))
    expect(onOpenDoc).toHaveBeenCalledWith('d1')
  })

  it('grows from the peek on a tap of the grab bar or the head; ✕ closes', () => {
    Element.prototype.setPointerCapture ??= () => {}
    const onFull = vi.fn()
    const onClose = vi.fn()
    panel({ sheet: true, onFull, onClose })
    const grab = screen.getByRole('button', { name: 'Detailhöhe anpassen' })
    expect(grab.getAttribute('aria-expanded')).toBe('false')
    fireEvent.pointerDown(grab, { clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(grab, { clientY: 500, pointerId: 1 })
    expect(onFull).toHaveBeenLastCalledWith(true)
    const head = screen.getByRole('heading', { name: 'Schloss Musterdorf' })
    fireEvent.pointerDown(head, { clientY: 520, pointerId: 2 })
    fireEvent.pointerUp(head, { clientY: 520, pointerId: 2 })
    expect(onFull).toHaveBeenCalledTimes(2)
    const closes = screen.getAllByRole('button', { name: 'Schliessen' })
    fireEvent.click(closes[closes.length - 1])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onFull).toHaveBeenCalledTimes(2)
  })

  it('folds back to the peek from full on a tap of the grab bar', () => {
    Element.prototype.setPointerCapture ??= () => {}
    const onFull = vi.fn()
    panel({ sheet: true, full: true, onFull })
    const grab = screen.getByRole('button', { name: 'Detailhöhe anpassen' })
    fireEvent.pointerDown(grab, { clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(grab, { clientY: 100, pointerId: 1 })
    expect(onFull).toHaveBeenLastCalledWith(false)
  })
})
