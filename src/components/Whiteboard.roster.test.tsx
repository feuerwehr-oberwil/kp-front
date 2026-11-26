// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef, useImperativeHandle, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { appConfig } from '../config/appConfig'
import { rosterFieldsToRefile } from '../lib/entityEdit'
import { fillTemplate } from '../lib/format'
import { rosterFieldRole } from '../lib/roleAssignment'
import { createUndoTimeline, type UndoTimeline } from '../lib/undoTimeline'
import { useUndoableDoc, type UndoableDoc } from '../lib/useUndoableDoc'
import type { Doc } from '../lib/workspace'
import type { SymbolsApi } from '../lib/useSymbols'
import type { BoardAnno, Entity, PlanDocument, SymbolProps } from '../types'
import { MapDetailPanels, type MapDetailPanelsProps } from '../workspace/MapDetailPanels'
import { Whiteboard } from './Whiteboard'
import type { BoardHistory } from './useBoardDoc'
import type { ContextPanel } from './ContextPanel'

// Both surfaces open the SAME symbol panel; what differs is only how each commits its patch.
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
    linkRosterFields, commitEntityFields: vi.fn(), patchEntity: vi.fn(), undoGroup: () => () => {}, vehicleOverrides: {}, layers: [],
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
    lage.props.onPatch({ fields: named }, 'commit')
    const expected = lage.calls().flatMap(filed)
    expect(expected).toEqual([{ value: 'Muster Hans', role: 'presence', note: fillTemplate(A.roleOffizier, { funktion: 'SiBe' }) }])
    cleanup()

    const plan = onPlan({ id: 'o1', kind: 'symbol', symbol: 'FW Offizier', fields, ...at })
    plan.props.onPatch({ fields: named }, 'commit')
    expect(plan.calls().flatMap(filed)).toEqual(expected)
  })

  it('a vehicle renamed TLF → TLF 2 re-files its Fahrer as «Fahrer TLF 2»', () => {
    const fields = { Fahrer: 'Muster Anna' }
    const lage = onLage({ id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF', fields, ...where })
    lage.props.onPatch({ label: 'TLF 2' }, 'commit')
    const expected = lage.calls().flatMap(filed)
    expect(expected).toEqual([{ value: 'Muster Anna', role: 'fahrer', note: fillTemplate(A.roleFahrer, { vehicle: 'TLF 2' }) }])
    cleanup()

    const plan = onPlan({ id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF', fields, ...at })
    plan.props.onPatch({ label: 'TLF 2' }, 'commit')
    expect(plan.calls().flatMap(filed)).toEqual(expected)
  })
})

/* ── One act, one ↶ (sweep 25.11.2026, found in #762) ──────────────────────────────────────────
   A rename that re-files the Fahrer took two ↶: the first gave back the Bemerkung while the label
   still showed the new name. Each surface below runs over a real history and the real timeline;
   only the Anwesenheit is a stand-in – one slice step that writes the Fahrer's Bemerkung. */

/** the Fahrer's Bemerkung on the Anwesenheit, written as one timeline step per filing */
const anwesenheit = (timeline: UndoTimeline, vehicle: string) => {
  const att = { note: fillTemplate(A.roleFahrer, { vehicle }) }
  const file = (prev: Pick<SymbolProps, 'label'>) => {
    const before = att.note
    const after = fillTemplate(A.roleFahrer, { vehicle: prev.label ?? '' })
    att.note = after
    timeline.push({ domain: 'anwesenheit', label: 'Anwesenheit', undo: () => { att.note = before }, redo: () => { att.note = after } })
  }
  return { att, file }
}

/** The Lage's panel over the Karte's own history; every step it lays is a timeline entry, as
 *  IncidentWorkspace records them. */
type Rig = { timeline: UndoTimeline; file: (prev: Pick<SymbolProps, 'label'>) => void }
function LageRig({ entity, timeline, file, karte }: Rig & { entity: Entity; karte: RefObject<UndoableDoc<Doc> | null> }) {
  const kd = useUndoableDoc<Doc>({ entities: [entity], drawings: [] }, false, (step) => {
    timeline.push({ domain: 'karte', label: 'Karte', undo: () => karte.current?.undo(step), redo: () => karte.current?.redo(step) })
  })
  useImperativeHandle(karte, () => kd)
  const titleLiveRef = useRef(false)
  const given: Partial<MapDetailPanelsProps> = {
    detailSlotFree: true, tacticalLocked: false, readOnly: false, tool: 'select', selected: kd.doc.entities[0], noteEntity: null,
    selectedDrawing: null, selectedDrawingId: null, drawings: [], entities: kd.doc.entities, effTrupps: [], rosterNames: [],
    pickablePersonnel: [], objects: [], timeline: [], titleLiveRef, entityTypedAt: { current: new Map() },
    sym: { byName: {}, symbols: [] } as unknown as MapDetailPanelsProps['sym'], doc: kd.doc,
    rosterFieldHints: () => undefined, personStatus: () => undefined, rosterRank: {}, isVisible: () => true,
    vehicleOverrides: {}, layers: [], emit: () => {}, commitEntityFields: vi.fn(),
    beginDrag: kd.beginDrag, endDrag: kd.endDrag, setDocRaw: kd.setDocRaw,
    patchEntity: (id, p) => kd.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...p } : e)) })),
    linkRosterFields: (prev, _fields, opts) => { if (opts?.force) file(prev) },
    undoGroup: () => timeline.group(),
  }
  return <MapDetailPanels {...given as MapDetailPanelsProps} />
}

/** The Plan's board over its own per-sheet history; every step it lays is a timeline entry, as
 *  workspace/usePlanStacks records them. */
function PlanRig({ anno, timeline, file, onLabel }: Rig & { anno: BoardAnno; onLabel: (label?: string) => void }) {
  const [annos, setAnnos] = useState([anno])
  const [hist, setHist] = useState<BoardHistory>({})
  const historyRef = useRef<{ undo: (expect?: string) => boolean; redo: (expect?: string) => boolean } | null>(null)
  return <Whiteboard
    plans={[tafel]} activeId="tafel" annos={annos} onChange={(next) => { setAnnos(next); onLabel(next[0].label) }}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} focus={null}
    hist={hist} setHist={setHist} historyRef={historyRef}
    onCheckpoint={(_plan, step) => timeline.push({ domain: 'plan', label: 'Plan', undo: () => historyRef.current!.undo(step), redo: () => historyRef.current!.redo(step) })}
    onRosterFields={(prev, _fields, opts) => { if (opts?.force) file(prev) }}
    undoGroup={() => timeline.group()}
  />
}

describe('a rename and the Bemerkung it re-files are ONE ↶ step', () => {
  const vehicle = { id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF', fields: { Fahrer: 'Muster Anna' } } as const
  /** type the new name, leave the field, then ↶ once and ↷ once */
  const renameUndoRedo = (timeline: UndoTimeline, att: { note: string }, label: () => string | undefined) => {
    const now = () => ({ label: label(), note: att.note })
    act(() => { panel.props!.onPatch({ label: 'TLF 2' }, 'typing') })
    act(() => { panel.props!.onPatch({ label: 'TLF 2' }, 'commit') })
    const after = now()
    act(() => { timeline.undo() })
    const undone = now()
    act(() => { timeline.redo() })
    return { after, undone, redone: now() }
  }
  const renamed = { label: 'TLF 2', note: fillTemplate(A.roleFahrer, { vehicle: 'TLF 2' }) }
  const before = { label: 'TLF', note: fillTemplate(A.roleFahrer, { vehicle: 'TLF' }) }

  it('on the Lage', () => {
    const timeline = createUndoTimeline()
    const { att, file } = anwesenheit(timeline, 'TLF')
    const karte = createRef<UndoableDoc<Doc>>()
    render(<LageRig entity={{ ...vehicle, ...where }} timeline={timeline} file={file} karte={karte} />)
    expect(renameUndoRedo(timeline, att, () => karte.current?.current().entities[0].label)).toEqual({ after: renamed, undone: before, redone: renamed })
  })

  it('on the Plan', () => {
    const timeline = createUndoTimeline()
    const { att, file } = anwesenheit(timeline, 'TLF')
    const drawn = { label: vehicle.label as string | undefined }
    const { container } = render(<PlanRig anno={{ ...vehicle, ...at }} timeline={timeline} file={file} onLabel={(l) => { drawn.label = l }} />)
    fireEvent.pointerDown(container.querySelector('.wb-symbol')!, { pointerType: 'mouse', isPrimary: true })
    expect(renameUndoRedo(timeline, att, () => drawn.label)).toEqual({ after: renamed, undone: before, redone: renamed })
  })

  // the step can only hold the filing if the sheet is written once, on the blur – while the
  // glyph and the panel still follow every keystroke
  it('the Plan draws the name being typed, and writes its sheet once, on the blur', () => {
    const timeline = createUndoTimeline()
    const { file } = anwesenheit(timeline, 'TLF')
    const written: (string | undefined)[] = []
    const { container } = render(<PlanRig anno={{ ...vehicle, ...at }} timeline={timeline} file={file} onLabel={(l) => { written.push(l) }} />)
    fireEvent.pointerDown(container.querySelector('.wb-symbol')!, { pointerType: 'mouse', isPrimary: true })
    act(() => { panel.props!.onPatch({ label: 'TLF 2' }, 'typing') })
    expect(panel.props!.entity.label).toBe('TLF 2')
    expect(written).toEqual([])
    act(() => { panel.props!.onPatch({ label: 'TLF 2' }, 'commit') })
    expect(written).toEqual(['TLF 2'])
  })
})
