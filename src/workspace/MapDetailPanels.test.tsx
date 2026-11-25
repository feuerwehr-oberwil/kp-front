// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MapDetailPanels, type MapDetailPanelsProps } from './MapDetailPanels'
import { appConfig } from '../config/appConfig'
import type { TacticalObject } from '../lib/tacticalObjects'
import type { Drawing, Entity, Trupp } from '../types'

/** Any input not named stands in as an inert, endlessly nestable stub (MapStage.test's helper). */
const inert = (): unknown => new Proxy(() => undefined, {
  get: (_, k) => (k === 'then' || typeof k === 'symbol' ? undefined : inert()),
  apply: () => undefined,
})
const withInert = <T,>(given: Partial<T>): T => new Proxy(given, {
  get: (t, k) => (k in t ? t[k as keyof typeof t] : inert()),
}) as T

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(cleanup)

const D = appConfig.copy.drawingEditor
const hose: Drawing = { id: 'd1', kind: 'line', coords: [[7.6, 47.5], [7.61, 47.5]] }

const mount = (drawing: Drawing, over: Partial<MapDetailPanelsProps> = {}) => {
  const setDrawingWallRole = vi.fn()
  render(<MapDetailPanels {...withInert<MapDetailPanelsProps>({
    detailSlotFree: true, tacticalLocked: false, readOnly: false, tool: 'select', selected: null, noteEntity: null,
    selectedDrawing: drawing, selectedDrawingId: drawing.id, drawings: [drawing], entities: [], effTrupps: [],
    pickablePersonnel: [], objects: [], setDrawingWallRole, ...over,
  })} />)
  const art = () => within(screen.getAllByRole('group', { name: D.kind })[0])
  return { setDrawingWallRole, art }
}

// sweep 28.10.2026, round 4 (owner: «I don't see the option to change the line type to wall and
// back in the map view»): the Karte's line editor carries the Plan's «Art: Linie | Wand» row
describe('«Art: Linie | Wand» on the Karte', () => {
  it('switches a Linie to a Wand, and a Wand back', () => {
    const { setDrawingWallRole, art } = mount(hose)
    fireEvent.click(art().getByRole('button', { name: new RegExp(`^${D.kindWand}`) }))
    expect(setDrawingWallRole).toHaveBeenCalledWith('d1', true)
    cleanup()
    const again = mount({ ...hose, role: 'wand' })
    fireEvent.click(again.art().getByRole('button', { name: D.kindLine }))
    expect(again.setDrawingWallRole).toHaveBeenCalledWith('d1', false)
  })

  it('a Wand offers no hose fields (Typ, Leitung Nr., Trupp) – a Linie still does', () => {
    const trupp = { id: 't9', name: 'Trupp 9', status: 'aktiv', entryPressureBar: 300, entryTime: '', lastContactTime: '' } satisfies Trupp
    mount(hose, { effTrupps: [trupp] })
    expect(screen.queryAllByText(D.lineNo).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(D.trupp).length).toBeGreaterThan(0)
    cleanup()
    mount({ ...hose, role: 'wand' }, { effTrupps: [trupp] })
    expect(screen.queryAllByText(D.lineNo)).toHaveLength(0)
    expect(screen.queryAllByText(D.content)).toHaveLength(0)
    expect(screen.queryAllByText(D.trupp)).toHaveLength(0)
  })

  it('«Wand» is disabled, with the reason, while a Trupp is on the line', () => {
    const { setDrawingWallRole, art } = mount(hose, { effTrupps: [{ id: 't1', name: 'Trupp 1', status: 'aktiv', entryPressureBar: 300, entryTime: '', lastContactTime: '', lineId: 'd1' } satisfies Trupp] })
    const wand = art().getByRole('button', { name: new RegExp(`^${D.kindWand}`) }) as HTMLButtonElement
    expect(wand.disabled).toBe(true)
    fireEvent.click(wand)
    expect(setDrawingWallRole).not.toHaveBeenCalled()
    expect(screen.getAllByText(D.kindWandBlocked).length).toBeGreaterThan(0)
  })

  it('…and for a Gebäude line that climbs storeys, asked through its sheet body', () => {
    const climbs: TacticalObject = { id: 'd1', drawing: hose, sheet: { planId: 'gebaeude', anno: { id: 'd1', kind: 'draw', floor: 0, pts: [[0, 0, 0], [1, 0, 1]] } } }
    const { art } = mount(hose, { objects: [climbs] })
    expect((art().getByRole('button', { name: new RegExp(`^${D.kindWand}`) }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText(D.kindWandStoreys).length).toBeGreaterThan(0)
  })

  it('an area has no «Art» row', () => {
    mount({ id: 'a1', kind: 'area', coords: [[7.6, 47.5], [7.61, 47.5], [7.61, 47.51]] })
    expect(screen.queryAllByRole('group', { name: D.kind })).toHaveLength(0)
  })
})

// ENT.2 (17.11.2026): «Zum Trupp» from the hose lands ON the card, as the Plan's twin does
describe('«Zum Trupp» in the Karte\'s Leitung editor', () => {
  it('focuses the Trupp working the hose, not just the board', () => {
    const trupp = { id: 't9', name: 'Trupp 9', status: 'aktiv', entryPressureBar: 300, entryTime: '', lastContactTime: '' } satisfies Trupp
    const showTrupp = vi.fn()
    mount({ ...hose, truppId: 't9' }, { effTrupps: [trupp], showTrupp, setSelectedDrawingId: vi.fn() })
    fireEvent.click(screen.getAllByRole('button', { name: D.truppShow })[0])
    expect(showTrupp).toHaveBeenCalledWith('t9')
  })
})

// hunt 24.11.2026, frontend-state F4: «Zurück auf GPS» is offered for a hand position or heading
// only – a Fahrer alone left it lit, and the reset then took the Fahrer away
describe('«Zurück auf GPS» on a live vehicle', () => {
  const C = appConfig.copy.contextPanel
  const tlf: Entity = { id: 'v1', kind: 'symbol', layer: 'gps', symbol: 'TLF', label: 'TLF', coord: [7.6, 47.5], live: true }
  const mountVehicle = (over: Partial<MapDetailPanelsProps>) => {
    const resetVehicleGps = vi.fn()
    render(<MapDetailPanels {...withInert<MapDetailPanelsProps>({
      detailSlotFree: true, tacticalLocked: false, readOnly: false, tool: 'select', selected: tlf, noteEntity: null,
      selectedDrawing: null, selectedDrawingId: null, drawings: [], entities: [tlf], effTrupps: [], rosterNames: [],
      pickablePersonnel: [], objects: [], resetVehicleGps, canEditIncident: true, timeline: [],
      sym: { byName: {}, symbols: [] } as unknown as MapDetailPanelsProps['sym'], doc: { entities: [tlf], drawings: [] },
      rosterFieldHints: () => undefined, personStatus: () => undefined, rosterRank: {}, isVisible: () => true, ...over,
    })} />)
    const button = screen.getAllByRole('button', { name: C.resetGpsTitle })[0] as HTMLButtonElement
    return { resetVehicleGps, button }
  }

  it('stays off for a vehicle whose only override is its Fahrer and Herkunft', () => {
    const { button } = mountVehicle({ vehicleOverrides: { v1: { fahrer: 'Meier', herkunft: 'Oberwil' } } })
    expect(button.disabled).toBe(true)
  })

  it('is on for a hand heading of 0°, and hands the reset to the one step writer', () => {
    const { button, resetVehicleGps } = mountVehicle({ vehicleOverrides: { v1: { rotation: 0, fahrer: 'Meier' } } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(resetVehicleGps).toHaveBeenCalledWith('v1', 'TLF')
  })
})
