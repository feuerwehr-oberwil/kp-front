// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { appConfig } from '../config/appConfig'
import { rosterFieldsToRefile } from '../lib/entityEdit'
import { fillTemplate } from '../lib/format'
import { rosterFieldRole } from '../lib/roleAssignment'
import type { SymbolsApi } from '../lib/useSymbols'
import type { BoardAnno, Entity, PlanDocument, SymbolProps } from '../types'
import { MapDetailPanels, type MapDetailPanelsProps } from '../workspace/MapDetailPanels'
import { Whiteboard } from './Whiteboard'
import type { ContextPanel } from './ContextPanel'

// Both surfaces open the SAME symbol panel; what differs is only how each wires its callbacks.
// The panel is stubbed to hand those callbacks to the test, so one edit can be made on the Lage
// and on the Plan and the two roster filings compared.
type PanelProps = ComponentProps<typeof ContextPanel>
const panel = vi.hoisted(() => ({ props: null as PanelProps | null }))
vi.mock('./ContextPanel', () => ({
  ContextPanel: (p: PanelProps) => { panel.props = p; return null },
}))

class RO { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  const el = Element.prototype as unknown as Record<string, unknown>
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
  el.hasPointerCapture ??= () => false
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); panel.props = null })

type RosterCall = [prev: Pick<SymbolProps, 'symbol' | 'label' | 'fields'>, fields: Record<string, string>, opts?: { force?: boolean }]

/** What `linkRosterFields` (workspace/useRosterRoles) files for one call: each name with its job. */
const filed = ([prev, fields, opts]: RosterCall) =>
  rosterFieldsToRefile(prev.fields, fields, appConfig.symbols.rosterFields, opts)
    .map(({ key, value }) => ({ value, ...rosterFieldRole(prev.symbol, key, prev.label, fields) }))

/** The Lage's symbol panel on `entity`; returns the panel's callbacks and the roster calls.
 *  Only the props this render reads are given – the panel itself is the stub above. */
const onLage = (entity: Entity) => {
  const linkRosterFields = vi.fn()
  const given: Partial<MapDetailPanelsProps> = {
    detailSlotFree: true, tacticalLocked: false, readOnly: false, tool: 'select', selected: entity, noteEntity: null,
    selectedDrawing: null, selectedDrawingId: null, drawings: [], entities: [entity], effTrupps: [], rosterNames: [],
    pickablePersonnel: [], objects: [], timeline: [], titleLiveRef: { current: false }, entityTypedAt: { current: new Map() },
    sym: { byName: {}, symbols: [] } as unknown as MapDetailPanelsProps['sym'], doc: { entities: [entity], drawings: [] },
    rosterFieldHints: () => undefined, personStatus: () => undefined, rosterRank: {}, isVisible: () => true,
    linkRosterFields, commitEntityFields: vi.fn(), patchEntity: vi.fn(), vehicleOverrides: {},
  }
  render(<MapDetailPanels {...given as MapDetailPanelsProps} />)
  const props = panel.props!
  return { props, calls: () => linkRosterFields.mock.calls as RosterCall[] }
}

const tafel: PlanDocument = { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape' }
const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }

/** The Plan's symbol panel on `anno`, opened by a press on the symbol. */
const onPlan = (anno: BoardAnno) => {
  const onRosterFields = vi.fn()
  const { container } = render(<Whiteboard
    plans={[tafel]} activeId="tafel" annos={[anno]} onChange={() => {}}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} hist={{}} setHist={() => {}} focus={null}
    onRosterFields={onRosterFields}
  />)
  fireEvent.pointerDown(container.querySelector('.wb-symbol')!, { pointerType: 'mouse', isPrimary: true })
  const props = panel.props!
  return { props, calls: () => onRosterFields.mock.calls as RosterCall[] }
}

const where = { coord: [7.6, 47.5] as [number, number], layer: 'lage' as const }
const at = { x: 0.5, y: 0.5, floor: 0 }
const A = appConfig.copy.anwesenheit

// sweep 25.11.2026 #4: the Plan sent one field at a time, without its siblings and without the
// label, so a name typed there was filed by a different rule than the same name on the Lage
describe('a name on a Plan symbol is filed like the same name on the Lage', () => {
  it('an Offizier named beside «Funktion: SiBe» is filed as «Offizier SiBe»', () => {
    const fields = { Funktion: 'SiBe', Name: '' }
    const named = { ...fields, Name: 'Muster Hans' }
    const lage = onLage({ id: 'o1', kind: 'symbol', symbol: 'FW Offizier', fields, ...where })
    lage.props.onFields(named)
    const expected = lage.calls().flatMap(filed)
    expect(expected).toEqual([{ value: 'Muster Hans', role: 'presence', note: fillTemplate(A.roleOffizier, { funktion: 'SiBe' }) }])
    cleanup()

    const plan = onPlan({ id: 'o1', kind: 'symbol', symbol: 'FW Offizier', fields, ...at })
    plan.props.onFields(named)
    expect(plan.calls().flatMap(filed)).toEqual(expected)
  })

  it('a vehicle renamed TLF → TLF 2 re-files its Fahrer as «Fahrer TLF 2»', () => {
    const fields = { Fahrer: 'Muster Anna' }
    const lage = onLage({ id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF', fields, ...where })
    lage.props.onTitle('TLF 2')
    const expected = lage.calls().flatMap(filed)
    expect(expected).toEqual([{ value: 'Muster Anna', role: 'fahrer', note: fillTemplate(A.roleFahrer, { vehicle: 'TLF 2' }) }])
    cleanup()

    const plan = onPlan({ id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF', fields, ...at })
    plan.props.onTitle('TLF 2')
    expect(plan.calls().flatMap(filed)).toEqual(expected)
  })
})
