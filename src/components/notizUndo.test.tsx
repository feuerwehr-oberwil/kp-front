// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useImperativeHandle, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
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
/** the Verlauf row of a Notiz that now says `value` (lib/entityEdit, the Lage's wording) */
const written = (value: string) => fillTemplate(N.log.noteWritten, { value })
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
      const note = kd.current().entities.find((e) => e.id === id)
      if (live) { if (note) kd.endDrag(); return }
      if (note && (note.label ?? '') !== v) patchEntity(id, { label: v })
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
const modul2: PlanDocument = { id: 'modul2', code: 'M2', title: 'Modul 2', subtitle: '', imageUrl: '', orientation: 'landscape' }
const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }

type PlanHistory = { undo: (expect?: string) => boolean; redo: (expect?: string) => boolean }
/** what a test does to the rig from outside: another device's write lands, the sheet switches */
type PlanDrive = { setAnnos: (annos: BoardAnno[]) => void; show: (planId: string) => void }
/** The Plan's board over its own per-sheet history; every step it lays is a timeline entry, as
 *  workspace/usePlanStacks records them. `seen` gets the sheet after every write; `seed` is the
 *  history the sheet starts with, stepped through `history`. Both sheets show the same annos – a
 *  Notiz the Karte lends to two sheets. */
function PlanRig({ annos: start, timeline, seen, seed = {}, history, emit, log = () => {}, drive }: { annos: BoardAnno[]; timeline: UndoTimeline; seen: (annos: BoardAnno[]) => void; seed?: BoardHistory; history?: RefObject<PlanHistory | null>; emit?: (op: string, payload?: Record<string, unknown>) => void; log?: (icon: string, text: string) => void; drive?: RefObject<PlanDrive | null> }) {
  const [annos, setAnnos] = useState(start)
  const [activeId, show] = useState('tafel')
  useImperativeHandle(drive, () => ({ setAnnos, show }))
  const own = useRef<PlanHistory | null>(null)
  const historyRef = history ?? own
  const [hist, setHist] = useState(seed)
  return <Whiteboard
    plans={[tafel, modul2]} activeId={activeId} annos={annos} onChange={(next) => { setAnnos(next); seen(next) }}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={log} focus={null} emit={emit}
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
    const log = vi.fn<(icon: string, text: string) => void>()
    const drive = createRef<PlanDrive>()
    const utils = render(<PlanRig annos={annos} timeline={timeline} seen={(a) => { sheet = a }} seed={seed} history={history} emit={emit} log={log} drive={drive} />)
    const now = () => ({ vehicle: sheet.find((a) => a.id === 'v1')?.label, note: sheet.find((a) => a.id === 'n1')?.text })
    /** the audit's edit rows for the Notiz: the text each records, and the sheet */
    const noteEdits = () => emit.mock.calls.filter(([op, p]) => op === 'board.edit' && p?.id === 'n1').map(([, p]) => (p as { patch: { text?: string } }).patch.text)
    const noteEditSheets = () => emit.mock.calls.filter(([op, p]) => op === 'board.edit' && p?.id === 'n1').map(([, p]) => (p as { planId: string }).planId)
    /** the Verlauf rows the board wrote */
    const rows = () => log.mock.calls.map(([, text]) => text)
    return { ...utils, timeline, now, noteEdits, noteEditSheets, rows, drive: () => drive.current!, sheet: () => sheet }
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

  it('another device removes it while it is typed: no row for the Notiz that is gone', () => {
    const start: BoardAnno[] = [{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }]
    const { noteEdits, drive } = mount(start)
    fireEvent.doubleClick(screen.getByText('Alt'))
    typeOnSheet('Wasser ab 14:20')
    act(() => drive().setAnnos(start.filter((a) => a.id !== 'n1')))
    expect(noteEdits()).toEqual([])
  })

  // a Notiz the Karte lends to the sheet: its ↶ is the Karte's, which hands the sheet the old text
  // back from outside (no board onRestore)
  it('the Karte’s ↶ gives a projected Notiz its old text back while it is typed: ✓ writes no row', () => {
    const start: BoardAnno[] = [{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }]
    const { noteEdits, drive } = mount(start)
    fireEvent.doubleClick(screen.getByText('Alt'))
    typeOnSheet('Wasser ab 14:20')
    act(() => drive().setAnnos(start))
    done()
    expect(noteEdits()).toEqual([])
  })

  it('a sheet switch while it is typed ends the edit on the sheet it was typed on', () => {
    const { noteEditSheets, rows, drive } = mount([{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }])
    fireEvent.doubleClick(screen.getByText('Alt'))
    typeOnSheet('Wasser ab 14:20')
    act(() => drive().show('modul2'))
    expect(noteEditSheets()).toEqual(['tafel'])
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })

  it('the board closing while it is typed ends the edit: its one row', () => {
    const { noteEdits, rows, unmount } = mount([{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }])
    fireEvent.doubleClick(screen.getByText('Alt'))
    typeOnSheet('Wasser ab 14:20')
    unmount()
    expect(noteEdits()).toEqual(['Wasser ab 14:20'])
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })
})

/* A Notiz written on the Plan reached the audit but never the Verlauf: the session's end compared
   the text with itself (sweep 25.11.2026). One row per editing session, against the text it began
   with – the Lage's wording and rules. */
describe('a Notiz typed on the plan writes its Verlauf row', () => {
  const at = { x: 0.5, y: 0.5, floor: 0 }
  const typeOnSheet = (text: string) => fireEvent.change(document.querySelector('.wb-text-input')!, { target: { value: text } })
  const done = () => fireEvent.pointerDown(screen.getByRole('button', { name: N.notes.done }))
  const blur = () => fireEvent.blur(document.querySelector('.wb-text-input')!)
  const mount = (text = 'Alt') => {
    const log = vi.fn<(icon: string, text: string) => void>()
    const timeline = createUndoTimeline()
    let sheet: BoardAnno[] = []
    render(<PlanRig annos={[{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text }]} timeline={timeline} seen={(a) => { sheet = a }} log={log} />)
    const open = () => fireEvent.doubleClick(document.querySelector('.wb-text-label')!)
    return { timeline, open, rows: () => log.mock.calls.map(([, t]) => t), note: () => sheet.find((a) => a.id === 'n1')?.text }
  }

  it('typed, the field blurred: one row with the text', () => {
    const { open, rows } = mount()
    open()
    typeOnSheet('Wasser ab 14:20')
    blur()
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })

  it('typed, ✓ (no blur): one row with the text', () => {
    const { open, rows } = mount()
    open()
    typeOnSheet('Wasser ab 14:20')
    done()
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })

  it('opened and closed with no change, or typed back to its text: no row', () => {
    const { open, rows } = mount()
    open()
    done()
    open()
    typeOnSheet('Altx')
    typeOnSheet('Alt')
    blur()
    expect(rows()).toEqual([])
  })

  it('emptied: the cleared wording', () => {
    const { open, rows } = mount()
    open()
    typeOnSheet('')
    blur()
    expect(rows()).toEqual([N.log.notesCleared])
  })

  it('many keys in one session: one row; a second session: a second row', () => {
    const { open, rows } = mount('')
    open()
    for (const t of ['W', 'Wa', 'Was', 'Wass', 'Wasser']) typeOnSheet(t)
    done()
    open()
    typeOnSheet('Wasser ab 14:20')
    blur()
    expect(rows()).toEqual([written('Wasser'), written('Wasser ab 14:20')])
  })

  // the sheet's own removal of the selected Notiz (usePlanRemoval · Delete), the field going with it
  it('typed, then removed in the same session: no «written» row', () => {
    const { open, rows, note } = mount()
    open()
    typeOnSheet('Wasser ab 14:20')
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(note()).toBeUndefined()
    expect(rows()).not.toContain(written('Wasser ab 14:20'))
  })

  it('typed, then ↶ in the same session: no row; ↶ after the session keeps its row', () => {
    const { open, rows, timeline, note } = mount()
    open()
    typeOnSheet('Wasser ab 14:20')
    act(() => { timeline.undo() })
    expect(note()).toBe('Alt')
    expect(rows()).toEqual([])
    open()
    typeOnSheet('Wasser ab 14:30')
    done()
    act(() => { timeline.undo() })
    expect(note()).toBe('Alt')
    // the Verlauf is append-only: the ↶ takes back the text, never the row
    expect(rows()).toEqual([written('Wasser ab 14:30')])
  })
})

/* …and one typed in its panel on the Plan: the panel's blur wrote only the audit row (sweep
   25.11.2026, Notiz Verlauf round). The same row and rules as the sheet's editor above. */
describe('a Notiz typed in its panel on the plan writes its Verlauf row', () => {
  const at = { x: 0.5, y: 0.5, floor: 0 }
  const blurNote = () => fireEvent.blur(document.querySelector('.ctx-note-input')!)
  /** the row is written once the act is over (Whiteboard · patchNote) */
  const settled = () => act(async () => {})
  const mount = () => {
    const log = vi.fn<(icon: string, text: string) => void>()
    const timeline = createUndoTimeline()
    let sheet: BoardAnno[] = []
    const drive = createRef<PlanDrive>()
    render(<PlanRig annos={[{ ...vehicle, ...at }, { id: 'n1', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'Alt' }]} timeline={timeline} seen={(a) => { sheet = a }} log={log} drive={drive} />)
    const open = () => fireEvent.pointerDown(document.querySelector('.wb-text-label')!, { pointerType: 'mouse', isPrimary: true })
    return { timeline, open, drive: () => drive.current!, rows: () => log.mock.calls.map(([, t]) => t), note: () => sheet.find((a) => a.id === 'n1')?.text }
  }

  it('typed, the field blurred: one row with the text', async () => {
    const { open, rows } = mount()
    open()
    typeNote('Wasser ab 14:20')
    blurNote()
    await settled()
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })

  it('opened and closed with no change: no row', async () => {
    const { open, rows } = mount()
    open()
    closeNote()
    await settled()
    expect(rows()).toEqual([])
  })

  it('emptied: the cleared wording', async () => {
    const { open, rows } = mount()
    open()
    typeNote('')
    closeNote()
    await settled()
    expect(rows()).toEqual([N.log.notesCleared])
  })

  it('many keys in one session: one row; a second session: a second row', async () => {
    const { open, rows } = mount()
    open()
    for (const t of ['W', 'Wa', 'Was', 'Wass', 'Wasser']) typeNote(t)
    blurNote()
    await settled()
    typeNote('Wasser ab 14:20')
    closeNote()
    await settled()
    expect(rows()).toEqual([written('Wasser'), written('Wasser ab 14:20')])
  })

  // the panel goes with its sheet and ends its typing as it goes; the sheet shown next has no Notiz
  it('another sheet shown while it is typed: its one row', async () => {
    const { open, rows, drive } = mount()
    open()
    typeNote('Wasser ab 14:20')
    act(() => { drive().show('modul2'); drive().setAnnos([{ ...vehicle, ...at }]) })
    await settled()
    expect(rows()).toEqual([written('Wasser ab 14:20')])
  })

  // «Entfernen» ends the typing just before the removal, whose own row names the text
  it('typed, then «Entfernen»: no «written» row', async () => {
    const { open, rows, note } = mount()
    open()
    typeNote('Wasser ab 14:20')
    await act(async () => { removeNote() })
    expect(note()).toBeUndefined()
    expect(rows()).not.toContain(written('Wasser ab 14:20'))
  })

  it('typed, then ↶ in the same session: no row; ↶ after the session keeps its row', async () => {
    const { open, rows, timeline, note } = mount()
    open()
    typeNote('Wasser ab 14:20')
    // the ↶ takes the panel with it, and the panel ends its typing as it goes
    act(() => { timeline.undo() })
    await settled()
    expect(note()).toBe('Alt')
    expect(rows()).toEqual([])
    open()
    typeNote('Wasser ab 14:30')
    closeNote()
    await settled()
    act(() => { timeline.undo() })
    expect(note()).toBe('Alt')
    expect(rows()).toEqual([written('Wasser ab 14:30')])
  })
})
