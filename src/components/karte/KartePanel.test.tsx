// @vitest-environment jsdom
// «Karte & Objekte» — the one panel: the capture door only for capture roles, a register hint
// that says where it came from, «In der Nähe» with its disclaimer, and missing data said, never
// read as «no hazard». Synthetic Musterdorf data only.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    sel={{ kind: 'object', obj: SCHLOSS }} register={ok} nearby={[]} visits={{ state: 'ok', list: [] }}
    canCapture docs={[]} sheet={false} withRail={false}
    onClose={vi.fn()} onStartVisit={vi.fn()} onReport={vi.fn()} onOpenDoc={vi.fn()}
    onSelectObject={vi.fn()} onRetryRegister={vi.fn()} onOpenVisit={vi.fn()}
    onPinBuilding={vi.fn()} onCopyCoords={vi.fn()} {...over}
  />,
)

describe('KartePanel', () => {
  it('shows the station word with its source, then the register as a hint', () => {
    panel()
    expect(screen.getByText('Zufahrt nur über Schlossgasse')).toBeTruthy()
    expect(screen.getByText('Station · Modul 1 · Stand 03.2026')).toBeTruthy()
    expect(screen.getByText('Heizung Gas')).toBeTruthy()
    // owner, review round 4: the source line (GWR, Stand …) is folded behind «Register-Hinweis»
    expect(screen.queryByText(/GWR Schlossgasse 9 · Stand 07.10.2026/)).toBeNull()
    const hint = screen.getByRole('button', { name: /Register-Hinweis/ })
    expect(hint.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(hint)
    expect(hint.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/GWR Schlossgasse 9 · Stand 07.10.2026/)).toBeTruthy()
    expect(screen.getByText(/Aus den Bundesregistern \(GWR, BFE\)/)).toBeTruthy()
    // the chips stand either way; a second tap folds it again
    expect(screen.getByText('Heizung Gas')).toBeTruthy()
    fireEvent.click(hint)
    expect(screen.queryByText(/GWR Schlossgasse 9/)).toBeNull()
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
    // owner, review round 4: the mismatch stays in view under the chips; only GWR · Stand fold
    expect(screen.getByText('Registereintrag Schlossgasse 11, nicht Schlossgasse 9')).toBeTruthy()
    expect(screen.queryByText(/GWR Schlossgasse 11/)).toBeNull()
    const section = screen.getByText('Heizung Gas').closest('[data-section="register"]')!
    const order = [...section.querySelectorAll('ul, [data-testid="register-other"]')].map((e) => e.tagName)
    expect(order[order.length - 1]).toBe('DIV')
    fireEvent.click(screen.getByRole('button', { name: /Register-Hinweis/ }))
    expect(screen.getByText(/GWR Schlossgasse 11/)).toBeTruthy()
    // said once, not again in the folded source line
    expect(screen.getAllByText(/nicht Schlossgasse 9/)).toHaveLength(1)
  })

  it('offers a pin «Melden» and the coordinates', () => {
    panel({ sel: { kind: 'pin', at: [7.57175, 47.52015], near: { label: 'Starenstrasse 19', distanceM: null }, nearState: 'ok', onBuilding: false } })
    expect(screen.getByText('bei Starenstrasse 19')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Melden$/ })).toBeTruthy()
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

// owner R2 (17.10.2026): the station's word first, the plans, then the rest, the actions LAST —
// «Objektbesuch» AND «Melden», no «Messen ab hier», no «Objektplan auf der Karte»; on a phone the
// Ebenen sheet's own frame, one height
describe('KartePanel · order and actions (R2)', () => {
  const PLAN = { id: 'plan:schloss:modul1', module: 'modul1', code: '1', title: 'Schloss – Übersicht', pages: 2, georef: true, version: 1, updatedAt: null }
  const DOCS = [
    { doc: { id: 'd1', code: '1', title: 'Übersicht', imageUrl: '/x.pdf' }, plan: PLAN, row: 'Modul 1' },
    { doc: { id: 'gebaeude', code: 'Gebäude', title: 'Gebäude', imageUrl: '', floorStack: true }, plan: null, row: 'Gebäude' },
  ] as unknown as ViewerPlanDoc[]
  const WITH_PLANS = { ...SCHLOSS, plans: [PLAN], remarks: 'Schlüssel beim Hauswart' } as unknown as StationObject
  const order = (c: HTMLElement) => [...c.querySelectorAll('[data-section]')].map((e) => e.getAttribute('data-section'))

  it('runs station word · plans · register · nearby · visits · actions, on the phone and the tablet', () => {
    for (const sheet of [true, false]) {
      const { container } = panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS, sheet })
      expect(order(container)).toEqual(['station', 'plans', 'register', 'nearby', 'visits', 'actions'])
      cleanup()
    }
  })

  it('a building and a pin keep the same order with what they have', () => {
    let r = panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: null } })
    expect(order(r.container)).toEqual(['register', 'nearby', 'visits', 'actions'])
    cleanup()
    r = panel({ sel: { kind: 'pin', at: [7.57175, 47.52015], near: null, nearState: 'none', onBuilding: false } })
    expect(order(r.container)).toEqual(['nearby', 'actions'])
    cleanup()
    // a plan-less object (once a «Schlüsseldepot», review round 3): the same order as any object —
    // its register, never a key-box note — with the plans left out
    r = panel({ sel: { kind: 'object', obj: { ...SCHLOSS, kind: 'objekt', plans: [], measures: null, measuresSource: null } } })
    expect(order(r.container)).toEqual(['register', 'nearby', 'visits', 'actions'])
    expect(screen.getByText('Stationsobjekt')).toBeTruthy()
    expect(r.container.textContent).not.toMatch(/Schlüsseldepot/)
  })

  it('shows «Objektbesuch» and «Melden» to a capture role only, and starts each', () => {
    const onStartVisit = vi.fn()
    const onReport = vi.fn()
    panel({ onStartVisit, onReport })
    fireEvent.click(screen.getByRole('button', { name: 'Objektbesuch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Melden' }))
    expect(onStartVisit).toHaveBeenCalledTimes(1)
    expect(onReport).toHaveBeenCalledTimes(1)
    cleanup()
    const { container } = panel({ canCapture: false })
    expect(screen.queryByRole('button', { name: 'Objektbesuch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Melden' })).toBeNull()
    expect(order(container)).not.toContain('actions')
    cleanup()
    // a building: «Melden» alone, no Objektbesuch without an object
    panel({ sel: { kind: 'building', at: [7.5708, 47.5228], address: null } })
    expect(screen.getByRole('button', { name: 'Melden' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Objektbesuch' })).toBeNull()
  })

  it('has no «Messen ab hier» and no «Objektplan auf der Karte» row', () => {
    for (const sel of [
      { kind: 'object' as const, obj: WITH_PLANS },
      { kind: 'building' as const, at: [7.5708, 47.5228] as [number, number], address: null },
      { kind: 'pin' as const, at: [7.5708, 47.5228] as [number, number], near: null, nearState: 'none' as const, onBuilding: false },
    ]) {
      const { container } = panel({ sel, docs: DOCS, sheet: true })
      expect(container.textContent).not.toMatch(/Messen ab hier|Objektplan auf der Karte/)
      expect(container.querySelector('[role="switch"]')).toBeNull()
      cleanup()
    }
  })

  // owner, review round 4: «just "modul 1", "modul 2", etc. is enough» — no title, no
  // «PDF · 2 Seiten · auf Karte ausgerichtet», no number badge; «Gebäude» stays «Gebäude»
  it('a plan row says «Modul 1» and nothing else, and opens the plan', () => {
    const onOpenDoc = vi.fn()
    const { container } = panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS, sheet: true, onOpenDoc })
    const rows = [...container.querySelectorAll('[data-section="plans"] button')]
    expect(rows.map((r) => r.textContent)).toEqual(['Modul 1', 'Gebäude'])
    // one shape for every row: the words, the chevron — no lead glyph, no second line
    for (const r of rows) {
      expect(r.querySelectorAll('b')).toHaveLength(1)
      expect(r.querySelector('[class*="rowLead"]')).toBeNull()
    }
    expect(container.textContent).not.toMatch(/Übersicht|PDF|ausgerichtet|Geschosse vorbereitet/)
    fireEvent.click(screen.getByRole('button', { name: 'Modul 1' }))
    expect(onOpenDoc).toHaveBeenCalledWith('d1')
  })

  it('offline, the «auf diesem Gerät» mark trails the row', () => {
    const avail = { plans: { 'plan:schloss:modul1@1': 'part' as const }, gebaeude: 'online' as const, georef: false }
    const { container } = panel({ sel: { kind: 'object', obj: WITH_PLANS }, docs: DOCS, sheet: true, offline: true, avail })
    const rows = [...container.querySelectorAll('[data-section="plans"] button')]
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Modul 1 · teilweise auf diesem Gerät', 'Gebäude · Nicht auf diesem Gerät gespeichert'])
    expect(rows[1].className).toMatch(/off/)
    expect(rows[0].className).not.toMatch(/off/)
  })

  it('on a phone wears the Ebenen sheet: its frame and grab bar, no peek; ✕ closes', () => {
    const onClose = vi.fn()
    const { container } = panel({ sheet: true, onClose })
    const sheet = container.querySelector('section')!
    expect(sheet.classList.contains('layers-card')).toBe(true)
    expect(sheet.querySelector(':scope > .ui-sheet-grab')).toBeTruthy()
    // one height: no grip that toggles a peek
    expect(screen.queryByRole('button', { name: 'Detailhöhe anpassen' })).toBeNull()
    const closes = screen.getAllByRole('button', { name: 'Schliessen' })
    fireEvent.click(closes[closes.length - 1])
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
    // the tablet keeps its own left panel
    const tab = panel()
    expect(tab.container.querySelector('section')!.classList.contains('layers-card')).toBe(false)
  })

  it('In der Nähe: one list by distance; a hydrant row says «Hydrant», «Nächster» and the direction, and shows it on hover or tap', () => {
    const onHydrant = vi.fn()
    const H = { id: 'h1', label: '632', coord: [7.5702, 47.5236] as [number, number] }
    const nearby = [
      { kind: 'hydrant' as const, item: H, distanceM: 25, dir: 4, nearest: true },
      { kind: 'object' as const, item: { ...SCHLOSS, id: 'kg', name: 'Kindergarten' }, distanceM: 62 },
    ]
    const { container } = panel({ nearby, onHydrant, litHydrant: 'h1' })
    const rows = [...container.querySelectorAll('[data-section="nearby"] button')]
    expect(rows.map((r) => r.textContent)).toEqual(['NächsterHydrantsüdlich25 m', 'KindergartenSchlossgasse 9, 9999 Musterdorf62 m'])
    // the index the FireGIS export carries is no hydrant number: never shown
    expect(screen.queryByText(/632/)).toBeNull()
    const row = rows[0]
    expect(row.getAttribute('aria-pressed')).toBe('true')
    // the mouse hovers; a finger's pointer events never do
    fireEvent.pointerEnter(row, { pointerType: 'touch' })
    expect(onHydrant).not.toHaveBeenCalled()
    fireEvent.pointerEnter(row, { pointerType: 'mouse' })
    fireEvent.pointerLeave(row, { pointerType: 'mouse' })
    fireEvent.click(row)
    expect(onHydrant.mock.calls).toEqual([['h1', 'enter'], ['h1', 'leave'], ['h1', 'tap']])
  })

  it('the switch «Objekt | <Haus>» stands under the head and opens the other level', () => {
    const onPick = vi.fn()
    const { container, rerender } = panel({ level: { on: 'object', plans: 3, house: null, onPick } })
    const group = screen.getByRole('group', { name: 'Objekt oder Haus' })
    // right under the head: the body's first part
    expect(container.querySelector('[data-section]')?.getAttribute('data-section')).toBe('level')
    // «Dieses Haus» until the register names the house
    expect(group.textContent).toBe('Objekt3 PläneDieses Hausnur dieses Haus')
    fireEvent.click(within(group).getByRole('button', { name: /^Objekt/ }))
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(within(group).getByRole('button', { name: /Dieses Haus/ }))
    expect(onPick).toHaveBeenCalledWith('house')
    // the house level: its street, «Teil von …» under the head, the switch still there
    rerender(
      <KartePanel sel={{ kind: 'building', at: [7.57, 47.52], address: null, partOf: 'Storchenweg 1-16' }} register={ok} nearby={[]} visits={{ state: 'ok', list: [] }}
        canCapture docs={[]} sheet withRail={false} level={{ on: 'house', plans: 1, house: 'Schlossgasse 9', onPick }}
        onClose={vi.fn()} onStartVisit={vi.fn()} onReport={vi.fn()} onOpenDoc={vi.fn()} onSelectObject={vi.fn()} onRetryRegister={vi.fn()}
        onOpenVisit={vi.fn()} onPinBuilding={vi.fn()} onCopyCoords={vi.fn()} />,
    )
    expect(screen.getByText('Teil von Storchenweg 1-16')).toBeTruthy()
    const level = screen.getByRole('group', { name: 'Objekt oder Haus' })
    expect(within(level).getByRole('button', { name: /Schlossgasse 9/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(level).getByRole('button', { name: /^Objekt/ }))
    expect(onPick).toHaveBeenLastCalledWith('object')
  })
})
