// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useImperativeHandle, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { appConfig } from '../config/appConfig'
import { createUndoTimeline, type UndoTimeline } from '../lib/undoTimeline'
import { useUndoableDoc, type UndoableDoc } from '../lib/useUndoableDoc'
import type { Doc } from '../lib/workspace'
import type { SymbolsApi } from '../lib/useSymbols'
import type { BoardAnno, Entity, PlanDocument } from '../types'
import { MapDetailPanels, type MapDetailPanelsProps } from '../workspace/MapDetailPanels'
import { Whiteboard } from './Whiteboard'
import type { BoardHistory } from './useBoardDoc'
import type { ContextPanel as RealPanel } from './ContextPanel'

/* A Notiz whose text field goes away while it still has the caret – ✕, «Entfernen», ✓ on the
   sheet, a tap elsewhere – gets no blur. Its typing step stayed open, and the NEXT act's ↶ took the
   Notiz edit back with it (sweep 26.11.2026, found in #792). The Notiz panel and the Plan's editor
   on the sheet here are the real ones; the symbol's panel is a stand-in that hands the test its
   write door, so a rename is one call. */
type PanelProps = ComponentProps<typeof RealPanel>
const symbolPanel = vi.hoisted(() => ({ props: null as PanelProps | null }))
vi.mock('./ContextPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ContextPanel')>()
  return {
    ...real,
    ContextPanel: (p: PanelProps) => {
      if (p.subject === 'note') return <real.ContextPanel {...p} />
      symbolPanel.props = p
      return null
    },
  }
})

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
afterEach(() => { cleanup(); symbolPanel.props = null })

const N = appConfig.copy
/** type into the open Notiz panel with the caret in it, and leave it there */
const typeNote = (text: string) => {
  const field = document.querySelector<HTMLTextAreaElement>('.ctx-note-input')!
  act(() => { field.focus() })
  fireEvent.change(field, { target: { value: text } })
}
const closeNote = () => fireEvent.click(screen.getByRole('button', { name: N.closeDialog }))
const removeNote = () => fireEvent.click(screen.getAllByRole('button', { name: N.remove })[0])
/** the Fahrzeug's name typed and taken in its panel, as the name list does it */
const rename = (label: string) => {
  act(() => { symbolPanel.props!.onPatch({ label }, 'typing') })
  act(() => { symbolPanel.props!.onPatch({ label }, 'commit') })
}

const vehicle = { id: 'v1', kind: 'symbol', symbol: appConfig.symbols.vehicleName, label: 'TLF' } as const

/* ── the Lage ─────────────────────────────────────────────────────────────────────────────────── */

type Open = 'note' | 'symbol' | null
/** The Lage's two panels over the Karte's own history; every step it lays is a timeline entry, as
 *  IncidentWorkspace records them. `show` picks the panel; `noteTextLive` / `noteTextEnd` are
 *  IncidentWorkspace's, minus the auto-width (the workspace itself: harness.writes › (n)). */
function LageRig({ entities, timeline, karte, show }: { entities: Entity[]; timeline: UndoTimeline; karte: RefObject<UndoableDoc<Doc> | null>; show: RefObject<((open: Open) => void) | null> }) {
  const kd = useUndoableDoc<Doc>({ entities, drawings: [] }, false, (step) => {
    timeline.push({ domain: 'karte', label: 'Karte', undo: () => karte.current?.undo(step), redo: () => karte.current?.redo(step) })
  })
  useImperativeHandle(karte, () => kd)
  const [open, setOpen] = useState<Open>(null)
  useImperativeHandle(show, () => setOpen)
  const titleLiveRef = useRef(false)
  const patchEntity = (id: string, p: Partial<Entity>) => kd.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...p } : e)) }))
  const byId = (id: string) => kd.doc.entities.find((e) => e.id === id) ?? null
  const given: Partial<MapDetailPanelsProps> = {
    detailSlotFree: true, tacticalLocked: false, readOnly: false, tool: 'select',
    selected: open === 'symbol' ? byId('v1') : null, noteEntity: open === 'note' ? byId('n1') : null,
    selectedDrawing: null, selectedDrawingId: null, drawings: [], entities: kd.doc.entities, effTrupps: [], rosterNames: [],
    pickablePersonnel: [], objects: [], timeline: [], titleLiveRef, entityTypedAt: { current: new Map() },
    sym: { byName: {}, symbols: [] } as unknown as MapDetailPanelsProps['sym'], doc: kd.doc,
    rosterFieldHints: () => undefined, personStatus: () => undefined, rosterRank: {}, isVisible: () => true,
    vehicleOverrides: {}, layers: [], emit: () => {}, commitEntityFields: vi.fn(), linkRosterFields: () => {},
    beginDrag: kd.beginDrag, endDrag: kd.endDrag, setDocRaw: kd.setDocRaw, patchEntity,
    undoGroup: () => timeline.group(), notePlacedId: null, setNoteDefaults: () => {},
    setNotePanelId: () => setOpen(null),
    noteTextLive: (id, v) => {
      if (!titleLiveRef.current) { titleLiveRef.current = true; kd.beginDrag() }
      kd.setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, label: v } : e)) }))
    },
    noteTextEnd: (id, v) => {
      const live = titleLiveRef.current
      titleLiveRef.current = false
      if (!kd.current().entities.some((e) => e.id === id)) { if (live) kd.dropDrag(); return }
      if (live) kd.endDrag()
      else patchEntity(id, { label: v })
    },
    deleteEntity: async (id) => { kd.commit((d) => ({ ...d, entities: d.entities.filter((e) => e.id !== id) })); return true },
  }
  return <MapDetailPanels {...given as MapDetailPanelsProps} />
}

describe('a Notiz panel that goes without a blur ends its typing step – on the Lage', () => {
  const where = { coord: [7.6, 47.5] as [number, number], layer: 'lage' as const }
  const note: Entity = { id: 'n1', kind: 'note', label: 'Alt', ...where }
  const mount = () => {
    const timeline = createUndoTimeline()
    const karte = createRef<UndoableDoc<Doc>>()
    const show = createRef<(open: Open) => void>()
    render(<LageRig entities={[{ ...vehicle, ...where }, note]} timeline={timeline} karte={karte} show={show} />)
    const now = () => {
      const es = karte.current!.current().entities
      return { vehicle: es.find((e) => e.id === 'v1')?.label, note: es.find((e) => e.id === 'n1')?.label }
    }
    return { timeline, now, open: (o: Open) => act(() => show.current!(o)) }
  }

  it('closed: the next rename’s ↶ gives back the name and leaves the Notiz text', () => {
    const { timeline, now, open } = mount()
    open('note')
    typeNote('Wasser ab 14:20')
    closeNote()
    open('symbol')
    rename('TLF 2')
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF', note: 'Wasser ab 14:20' })
  })

  it('removed: the next rename’s ↶ does not bring the Notiz back', async () => {
    const { timeline, now, open } = mount()
    open('note')
    typeNote('Wasser ab 14:20')
    await act(async () => { removeNote() })
    open('symbol')
    rename('TLF 2')
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF', note: undefined })
    // …the ↶ after it gives the Notiz back as it was removed, with what was typed, and the
    // typing is a step of its own: the next ↶ takes back only that
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF', note: 'Wasser ab 14:20' })
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF', note: 'Alt' })
  })
})

/* ── the Plan ─────────────────────────────────────────────────────────────────────────────────── */

const tafel: PlanDocument = { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape' }
const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }

type PlanHistory = { undo: (expect?: string) => boolean; redo: (expect?: string) => boolean }
/** The Plan's board over its own per-sheet history; every step it lays is a timeline entry, as
 *  workspace/usePlanStacks records them. `seen` gets the sheet after every write; `seed` is the
 *  history the sheet starts with, stepped through `history`. */
function PlanRig({ annos: start, timeline, seen, seed = {}, history, emit }: { annos: BoardAnno[]; timeline: UndoTimeline; seen: (annos: BoardAnno[]) => void; seed?: BoardHistory; history?: RefObject<PlanHistory | null>; emit?: (op: string, payload?: Record<string, unknown>) => void }) {
  const [annos, setAnnos] = useState(start)
  const own = useRef<PlanHistory | null>(null)
  const historyRef = history ?? own
  const [hist, setHist] = useState(seed)
  return <Whiteboard
    plans={[tafel]} activeId="tafel" annos={annos} onChange={(next) => { setAnnos(next); seen(next) }}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} focus={null} emit={emit}
    hist={hist} setHist={setHist} historyRef={historyRef}
    onCheckpoint={(_plan, step) => timeline.push({ domain: 'plan', label: 'Plan', undo: () => historyRef.current!.undo(step), redo: () => historyRef.current!.redo(step) })}
    undoGroup={() => timeline.group()}
  />
}

describe('a Notiz panel that goes without a blur ends its typing step – on the Plan', () => {
  const at = { x: 0.5, y: 0.5, floor: 0 }
  // the Plan lays the Notiz's step at its first keystroke, so the fault shows on the NEXT Notiz
  // edit: it folded into whatever step came last – here the rename
  it('closed, then a rename, then typed again: ↶ takes back only the new text', () => {
    const timeline = createUndoTimeline()
    let sheet: BoardAnno[] = []
    const { container } = render(<PlanRig annos={[{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }]} timeline={timeline} seen={(a) => { sheet = a }} />)
    const now = () => ({ vehicle: sheet.find((a) => a.id === 'v1')?.label, note: sheet.find((a) => a.id === 'n1')?.text })
    const tap = (el: Element) => fireEvent.pointerDown(el, { pointerType: 'mouse', isPrimary: true })
    tap(screen.getByText('Alt'))
    typeNote('Wasser ab 14:20')
    closeNote()
    tap(container.querySelector('.wb-symbol')!)
    rename('TLF 2')
    tap(screen.getByText('Wasser ab 14:20'))
    typeNote('Wasser ab 14:30')
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF 2', note: 'Wasser ab 14:20' })
  })
})

describe('a Notiz typed in the editor on the plan, which goes without a blur', () => {
  const at = { x: 0.5, y: 0.5, floor: 0 }
  const tap = (el: Element) => fireEvent.pointerDown(el, { pointerType: 'mouse', isPrimary: true })
  const typeOnSheet = (text: string) => fireEvent.change(document.querySelector('.wb-text-input')!, { target: { value: text } })
  const done = () => fireEvent.pointerDown(screen.getByRole('button', { name: N.notes.done }))
  /** `placed`: the sheet holds that anno as just put down – its placing is the step on the stack */
  const mount = (annos: BoardAnno[], placed?: string) => {
    const timeline = createUndoTimeline()
    let sheet: BoardAnno[] = annos
    const history = createRef<PlanHistory>()
    const seed: BoardHistory = placed ? { tafel: { past: [{ id: 'placed', snap: annos.filter((a) => a.id !== placed) }], future: [] } } : {}
    if (placed) timeline.push({ domain: 'plan', label: 'Plan', undo: () => history.current!.undo('placed'), redo: () => history.current!.redo('placed') })
    const emit = vi.fn()
    const utils = render(<PlanRig annos={annos} timeline={timeline} seen={(a) => { sheet = a }} seed={seed} history={history} emit={emit} />)
    const now = () => ({ vehicle: sheet.find((a) => a.id === 'v1')?.label, note: sheet.find((a) => a.id === 'n1')?.text })
    /** the audit's edit rows for the Notiz, by the text they record */
    const noteEdits = () => emit.mock.calls.filter(([op, p]) => op === 'board.edit' && p?.id === 'n1').map(([, p]) => (p as { patch: { text?: string } }).patch.text)
    return { ...utils, timeline, now, noteEdits }
  }

  // ✓ ends the editor with no blur; its typing marker stayed set, and the next typing in that
  // Notiz folded into the step laid last – here the rename
  it('✓, then a rename, then typed again: ↶ takes back only the new text', () => {
    const { container, timeline, now } = mount([{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }])
    fireEvent.doubleClick(screen.getByText('Alt'))
    typeOnSheet('Wasser ab 14:20')
    done()
    tap(container.querySelector('.wb-symbol')!)
    rename('TLF 2')
    fireEvent.doubleClick(screen.getByText('Wasser ab 14:20'))
    typeOnSheet('Wasser ab 14:30')
    done()
    act(() => { timeline.undo() })
    expect(now()).toEqual({ vehicle: 'TLF 2', note: 'Wasser ab 14:20' })
  })

  it('↶ until the Notiz is gone: ↷ brings it back with what was typed', () => {
    const { timeline, now, noteEdits } = mount([{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: '' }], 'n1')
    fireEvent.doubleClick(document.querySelector('.wb-text-label')!)
    typeOnSheet('Wasser ab 14:20')
    act(() => { timeline.undo() })
    act(() => { timeline.undo() })
    expect(now().note).toBeUndefined()
    // the typing the ↶ took back leaves no audit row with its text
    expect(noteEdits()).toEqual([])
    act(() => { timeline.redo() })
    act(() => { timeline.redo() })
    expect(now()).toEqual({ vehicle: 'TLF', note: 'Wasser ab 14:20' })
  })
})

