// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BoardAnno, BuildingDoc, PlanDocument, Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import type { SymbolsApi } from '../lib/useSymbols'
import { NODE_HOLD_ARM_MS, NODE_HOLD_FIRE_MS, NODE_HOLD_MOVE_PX } from '../lib/nodeHold'

// The OSM sheet fetches live footprints from the backend; the surface's CONTRACT is what is
// under test, so the outline component is stubbed down to the one thing it does — report how it
// was armed, and hand a picked footprint back.
const osm = vi.hoisted(() => ({ calls: [] as { interactive?: boolean }[] }))
const lastArmed = () => osm.calls[osm.calls.length - 1]?.interactive
vi.mock('./OsmOutline', () => ({
  OsmOutline: (p: { interactive?: boolean; onPick?: (src: [number, number][][], deg: number) => void }) => {
    osm.calls.push({ interactive: p.interactive })
    return <button onClick={() => p.onPick?.([[[0, 0], [1, 0], [1, 1]]], 0)}>Umriss</button>
  },
  prefetchOutlines: () => {},
}))

// the auto-commit release talks through the global toast pill — recorded here so the tests can
// read its text and press its «Rückgängig» without mounting the app-level toast host
const ui = vi.hoisted(() => ({ toasts: [] as { text: string; action?: { label: string; onClick: () => void } }[] }))
vi.mock('../lib/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/ui')>()
  return {
    ...mod,
    toast: (text: string, opts?: { action?: { label: string; onClick: () => void } }) => { ui.toasts.push({ text, action: opts?.action }); return 1 },
  }
})

import { Whiteboard } from './Whiteboard'

class RO { observe() {} unobserve() {} disconnect() {} }

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  // jsdom implements no pointer capture; every drag handler on this surface claims it
  const el = Element.prototype as unknown as Record<string, unknown>
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
  el.hasPointerCapture ??= () => false
  // jsdom has no matchMedia; pinned to «not a phone» (the rail is a side rail, not a bottom bar).
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); osm.calls.length = 0 })

const umrisse: PlanDocument = {
  id: 'osm', code: 'Umrisse', title: 'Gebäudeumrisse', subtitle: '', imageUrl: '',
  orientation: 'landscape', osm: { center: [7.6, 47.5], radiusM: 250 },
}
const tafel: PlanDocument = {
  id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape',
}
const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }
// an annotation somebody drew on the Umrisse sheet BEFORE it became selection-only
const oldNote: BoardAnno = { id: 'a1', kind: 'text', x: 0.4, y: 0.4, floor: 0, text: 'Alte Notiz' }

const gebaeudeDoc: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Gebäude', subtitle: '', imageUrl: '',
  orientation: 'portrait', icon: 'floors', floorStack: true,
}
const aBuilding: BuildingDoc = {
  ring: [[0, 0], [1, 0], [1, 1], [0, 1]], ringAspect: 1, floors: [0],
}

const renderBoard = (activeId: string, annos: BoardAnno[] = [], readOnly = false, building: BuildingDoc | null = null) => {
  const onSelectBuilding = vi.fn()
  const onBuildingFace = vi.fn()
  render(<Whiteboard
    plans={[umrisse, gebaeudeDoc, tafel]}
    activeId={activeId}
    annos={annos}
    onChange={() => {}}
    building={building}
    onSelectBuilding={onSelectBuilding}
    onBuildingFace={onBuildingFace}
    onAddFloor={() => {}}
    onRemoveFloor={() => {}}
    readOnly={readOnly}
    slimTools
    sym={sym}
    onRecent={() => {}}
    log={() => {}}
    hist={{}}
    setHist={() => {}}
    focus={null}
  />)
  return { onSelectBuilding, onBuildingFace }
}

// «Umrisse» exists to pick the building that becomes the Gebäude view. A tool that could only
// annotate a live OSM backdrop is a tool that lies, so the whole drawing apparatus is gone here —
// deliberately NOT the Lage↔Plan parity the other plan surfaces keep.
describe('the Umrisse surface', () => {
  const CREATE_TOOLS = ['Linie', 'Fläche', 'Notiz', 'Trupp', 'Mehrfach']

  it('offers no tool at all — not even the read-only Auswahl · Messen rail', () => {
    renderBoard('osm')
    for (const label of [...CREATE_TOOLS, 'Auswahl', 'Messen']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('keeps every tool on the Tafel — the rail is missing because of the SURFACE, not the build', () => {
    renderBoard('tafel')
    for (const label of CREATE_TOOLS) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('still picks a building — the one interaction the sheet is for', () => {
    const { onSelectBuilding } = renderBoard('osm')
    expect(lastArmed()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Umriss' }))
    expect(onSelectBuilding).toHaveBeenCalled()
  })

  it('does not pick for a locked/viewer session — that pick would rewrite the Gebäude', () => {
    renderBoard('osm', [], true)
    expect(lastArmed()).toBe(false)
  })

  it('still renders what was drawn here before the rule — the board is a synced document', () => {
    renderBoard('osm', [oldNote])
    expect(screen.getByText('Alte Notiz')).toBeTruthy()
  })
})

// ── The ONE «Gebäude» tile ──────────────────────────────────────────────────────────────────
// The rail lists the outline picker and the floor stack as one entry that morphs, so the way
// from one face to the other is a chip in the bottom-left row — and it exists exactly where
// there is somewhere to go. A door onto nothing would be worse than no door.
describe('the door between the two faces of the Gebäude tile', () => {
  const OTHER = 'Anderes Gebäude wählen'
  const BACK = 'Zurück zum Gebäude'

  it('offers no way back while no building has been picked yet', () => {
    renderBoard('osm')
    expect(screen.queryByRole('button', { name: OTHER })).toBeNull()
    expect(screen.queryByRole('button', { name: BACK })).toBeNull()
  })

  it('sends the floor stack to the picker', () => {
    const { onBuildingFace } = renderBoard('gebaeude', [], false, aBuilding)
    fireEvent.click(screen.getByRole('button', { name: OTHER }))
    expect(onBuildingFace).toHaveBeenCalledWith('pick')
  })

  it('sends the picker back to the stack it already has', () => {
    const { onBuildingFace } = renderBoard('osm', [], false, aBuilding)
    fireEvent.click(screen.getByRole('button', { name: BACK }))
    expect(onBuildingFace).toHaveBeenCalledWith('stack')
  })

  // Pure navigation between two surfaces — it mutates nothing, so a locked/viewer session keeps it.
  it('stays for a locked session', () => {
    renderBoard('gebaeude', [], true, aBuilding)
    expect(screen.getByRole('button', { name: OTHER })).toBeTruthy()
  })
})

// ── Lage↔Plan parity: the halves that were map-only ─────────────────────────────────────────
// The rule is one rule: a Leitung, a Trupp and a Symbol behave the same whether you are looking
// at the Karte or at Modul 1. What follows guards the two places where the plan used to differ
// in KIND — not in styling — because a difference in kind is what makes an operator hesitate.

const TRUPPS: Trupp[] = [
  { id: 't1', name: 'Trupp 1', status: 'aktiv', members: [], pressure: 300, readings: [], startedAt: '' } as unknown as Trupp,
  { id: 't2', name: 'Trupp 2', status: 'raus', members: [], pressure: 300, readings: [], startedAt: '' } as unknown as Trupp,
]

const renderPlan = (annos: BoardAnno[], extra: Partial<React.ComponentProps<typeof Whiteboard>> = {}) => {
  const onChange = vi.fn()
  const utils = render(<Whiteboard
    plans={[tafel]} activeId="tafel" annos={annos} onChange={onChange}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} hist={{}} setHist={() => {}} focus={null}
    {...extra}
  />)
  return { ...utils, onChange }
}

const chip: BoardAnno = { id: 'c1', kind: 'resource', x: 0.5, y: 0.5, floor: 0, text: 'Trupp 1', t: '03:12' }
const line: BoardAnno = { id: 'l1', kind: 'draw', pts: [[0.2, 0.2, 0], [0.8, 0.8, 0]], floor: 0 }
// the fat transparent hit surface WbInkLayer lays over each stroke — the only way to tap ink
const hitShape = (c: HTMLElement) => c.querySelector('.wb-ink-svg polyline[style], .wb-ink-svg polygon[style]')!

describe('the plan chip’s «Atemschutz-Trupp» menu (the map marker’s twin)', () => {
  const A = appConfig.copy.atemschutz

  it('joins a chip to a Trupp from the picture, not only from the AT card', () => {
    const onTeamTrupp = vi.fn()
    renderPlan([chip], { trupps: TRUPPS, onTeamTrupp })
    fireEvent.pointerDown(screen.getByText('Trupp 1'))
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Trupp 1' }))
    expect(onTeamTrupp).toHaveBeenCalledWith('c1', 't1')
  })

  it('lets go of the one it has — «Kein Trupp», the same wording the marker uses', () => {
    const onTeamTrupp = vi.fn()
    renderPlan([{ ...chip, truppId: 't1' }], { trupps: TRUPPS, onTeamTrupp })
    fireEvent.pointerDown(screen.getByText('Trupp 1'))
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    fireEvent.click(screen.getByRole('menuitem', { name: A.markerNone }))
    expect(onTeamTrupp).toHaveBeenCalledWith('c1', undefined)
  })

  // …the record of who WAS, not somebody to send: an out Trupp shows only where it is the one
  // standing here. Same filter as the map marker's menu.
  it('does not offer a Trupp that is already out', () => {
    renderPlan([chip], { trupps: TRUPPS, onTeamTrupp: vi.fn() })
    fireEvent.pointerDown(screen.getByText('Trupp 1'))
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    expect(screen.queryByRole('menuitem', { name: 'Trupp 2' })).toBeNull()
  })

  it('has no menu at all where the join is not on offer (locked / no Atemschutz board)', () => {
    renderPlan([chip], { trupps: TRUPPS })
    fireEvent.pointerDown(screen.getByText('Trupp 1'))
    expect(screen.queryByRole('button', { name: A.markerLabel })).toBeNull()
  })

  // a bound chip's name is the TRUPP's, written on the Atemschutz board — renaming it here would
  // fork the two apart, which is exactly why the map marker drops its pen too
  it('drops the rename pen once the chip belongs to a Trupp', () => {
    renderPlan([{ ...chip, truppId: 't1' }], { trupps: TRUPPS, onTeamTrupp: vi.fn() })
    fireEvent.pointerDown(screen.getByText('Trupp 1'))
    expect(screen.queryByRole('button', { name: appConfig.copy.edit })).toBeNull()
  })
})

describe('a locked line on the plan (BoardAnno.locked — the twin of Drawing.locked)', () => {
  const D = appConfig.copy.drawingEditor

  it('opens its editor when it is NOT locked', () => {
    const { container } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    // …twice: the editor pins its action row at the sheet bottom AND inside the scrolling body
    // for phones, and CSS shows exactly one of them (DrawEditor · actions)
    expect(screen.getAllByRole('button', { name: new RegExp(D.lock) }).length).toBeGreaterThan(0)
  })

  it('keeps its detail editor open beside Ebenen above the phone breakpoint', () => {
    const { container } = renderPlan([line], { layersOn: true })
    fireEvent.pointerDown(hitShape(container))
    expect(screen.getAllByRole('button', { name: new RegExp(D.lock) }).length).toBeGreaterThan(0)
  })

  it('is tap-through once locked — no selection, no editor, no drag', () => {
    const { container, onChange } = renderPlan([{ ...line, locked: true }])
    fireEvent.pointerDown(hitShape(container))
    fireEvent.pointerMove(hitShape(container), { clientX: 400, clientY: 400 })
    expect(screen.queryAllByRole('button', { name: new RegExp(D.lock) })).toHaveLength(0)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('carries the unlock chip — its only tap target — and nothing else does', () => {
    const { container } = renderPlan([{ ...line, locked: true }])
    expect(container.querySelector('.wb-lock-anchor')).toBeTruthy()
    cleanup()
    const plain = renderPlan([line])
    expect(plain.container.querySelector('.wb-lock-anchor')).toBeNull()
  })

  // the clock is nodeHold's, not a number of this chip's own — «Entsperren» shares the one hold
  // every node handle uses, so the test asserts against that constant rather than pinning a
  // duplicate of it here (the drift the shared hook exists to prevent).
  it('unlocks on a short HOLD, never on a stray tap', () => {
    vi.useFakeTimers()
    const { onChange } = renderPlan([{ ...line, locked: true }])
    const held = screen.getByRole('button', { name: D.unlockHold })
    fireEvent.pointerDown(held)
    fireEvent.pointerUp(held) // a tap: the hold is cancelled, nothing changes
    vi.advanceTimersByTime(NODE_HOLD_FIRE_MS * 2)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerDown(held)
    // still short of the fire time: the ring is filling, but nothing has happened yet
    vi.advanceTimersByTime(NODE_HOLD_FIRE_MS - 50)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls[0][0][0].locked).toBeUndefined()
    vi.useRealTimers()
  })

  // movement is what separates «ich will das aufmachen» from «ich wollte etwas anderes treffen».
  // The ring is asserted BEFORE the move on purpose: without it this test would also pass if the
  // hold had never armed at all, which is exactly the bug it is supposed to catch.
  it('abandons the unlock when the finger slides off the chip', () => {
    vi.useFakeTimers()
    const { container, onChange } = renderPlan([{ ...line, locked: true }])
    const held = screen.getByRole('button', { name: D.unlockHold })
    fireEvent.pointerDown(held, { clientX: 0, clientY: 0 })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_ARM_MS + 50) })
    expect(container.querySelector('.node-del.tone-unlock')).toBeTruthy()
    act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: NODE_HOLD_MOVE_PX + 6 }) })
    expect(container.querySelector('.node-del.tone-unlock')).toBeNull()
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS * 2) })
    expect(onChange).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

// ── The 29.08. Plan decisions ───────────────────────────────────────────────────────────────
// Messen left the rail (deliberate Lage↔Plan divergence), the floating delete orbs left the
// canvas (the detail panel is the one delete), a note opens on TAP like a symbol, the Punkte
// draft carries real vertex handles, and tap-away releases a draft instead of eating it.
describe('Plan round 3 (29.08.)', () => {
  const T = appConfig.copy.toolDock
  const W = appConfig.copy.whiteboard
  // toNorm and the handle layout need a real board rect, which jsdom never lays out.
  // ⚠️ The toast log is cleared BEFORE each test, not after: afterEach hooks run LIFO, so the
  // file-level cleanup() unmounts the previous board AFTER an afterEach here — and an unmount
  // with a live draft auto-commits and toasts (by design), which would leak into the next test.
  beforeEach(() => {
    ui.toasts.length = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const ink = (c: HTMLElement) => c.querySelector('.wb-ink')!
  const tapAt = (el: Element, x: number, y: number) => {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: 1 })
  }
  // three area taps, far enough apart that none reads as the double-tap finish
  const drawAreaDraft = (c: HTMLElement) => {
    fireEvent.click(screen.getByRole('button', { name: 'Fläche' }))
    tapAt(ink(c), 100, 100); tapAt(ink(c), 300, 100); tapAt(ink(c), 200, 300)
  }

  // Messen left the Plan rail on 29.08. and came BACK on 02.09. (field feedback: the quick
  // «wie weit?» glance kept reaching for it) — see usePlanMeasure's header.
  it('offers the Messen tool on the Plan again (02.09.)', () => {
    renderPlan([])
    expect(screen.getByRole('button', { name: 'Linie' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Messen' })).toBeTruthy()
  })

  it('keeps the slim read-only rail: Auswahl + Messen', () => {
    renderPlan([], { readOnly: true, slimTools: true })
    expect(screen.getByRole('button', { name: 'Auswahl' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Messen' })).toBeTruthy()
  })

  it('gives the in-progress Punkte draft real vertex grips and «+» inserts', () => {
    const { container } = renderPlan([])
    drawAreaDraft(container)
    expect(screen.getAllByRole('button', { name: W.dragVertex })).toHaveLength(3)
    // 2 open segments + the closing edge of the ring
    const inserts = screen.getAllByRole('button', { name: W.insertVertex })
    expect(inserts).toHaveLength(3)
    // pressing a «+» splices a node right there (and hands the same press its drag)
    fireEvent.pointerDown(inserts[0], { clientX: 200, clientY: 100, pointerId: 2 })
    expect(screen.getAllByRole('button', { name: W.dragVertex })).toHaveLength(4)
  })

  it('auto-commits a committable draft on tap-away — and «Rückgängig» hands the shape back', () => {
    const { container, onChange } = renderPlan([])
    drawAreaDraft(container)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl' }))
    // committed through the ordinary addArea path…
    const committed = onChange.mock.calls[0][0]
    expect(committed).toHaveLength(1)
    expect(committed[0].kind).toBe('area')
    expect(committed[0].pts).toHaveLength(3)
    // …with the decided toast
    const t = ui.toasts.find((x) => x.text === T.autoCommitted.replace('{name}', appConfig.copy.drawingEditor.area))
    expect(t?.action?.label).toBe(T.autoCommitUndo)
    // undo returns the shape to the HAND: anno removed, draft + tool re-armed
    act(() => t!.action!.onClick())
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][0]).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: W.dragVertex })).toHaveLength(3)
  })

  it('discards a fragment with a toast instead of silently — and commits nothing', () => {
    const { container, onChange } = renderPlan([])
    fireEvent.click(screen.getByRole('button', { name: 'Fläche' }))
    tapAt(ink(container), 100, 100); tapAt(ink(container), 300, 100) // a 2-point Fläche is nothing yet
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(ui.toasts.some((x) => x.text === T.draftDiscarded && !x.action)).toBe(true)
  })

  it('Escape stays the explicit discard — no commit, no toast', () => {
    const { container, onChange } = renderPlan([])
    drawAreaDraft(container)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(ui.toasts).toHaveLength(0)
    expect(screen.queryByRole('button', { name: W.dragVertex })).toBeNull()
  })

  it('shows no floating ✕ on a selected symbol — Löschen lives in its panel', () => {
    const { container } = renderPlan([{ id: 's1', kind: 'symbol', x: 0.5, y: 0.5, floor: 0, symbol: 'brand', label: 'Brand' }])
    fireEvent.pointerDown(container.querySelector('.wb-symbol')!)
    expect(container.querySelector('.wb-del')).toBeNull()
    // the ContextPanel opened by the same tap carries the delete
    expect(screen.getAllByRole('button', { name: appConfig.copy.delete }).length).toBeGreaterThan(0)
  })

  it('opens a note’s panel on a plain TAP — the symbol grammar, no grips row', () => {
    const { container } = renderPlan([{ id: 'n1', kind: 'text', x: 0.5, y: 0.5, floor: 0, text: 'Hallo' }])
    expect(screen.queryByRole('button', { name: appConfig.copy.delete })).toBeNull()
    fireEvent.pointerDown(screen.getByText('Hallo'))
    expect(container.querySelector('.note-grips')).toBeNull()
    expect(screen.getAllByRole('button', { name: appConfig.copy.delete }).length).toBeGreaterThan(0)
  })
})

// ── A23 · read-only never gets grips ────────────────────────────────────────────────────────
// The Karte states the rule and the reason (MapView · editDraw): «read-only never gets handles —
// grabbable-looking vertices would move under the finger and snap back, the worst kind of 3am
// lie». On the Plan they did more than lie: the surface's readOnly is broader than the write
// guard upstream, so on a phone with the Verlauf open the grips actually wrote.
describe('a locked plan surface hands out no reshape grips', () => {
  const W = appConfig.copy.whiteboard
  // `focus` is the door a read-only surface still has into a selection («Leitung zeigen», the
  // ContextPanel's Verbindungen list) — and it only opens once the board has been measured, so
  // jsdom needs a size for both the viewport (clientWidth) and the sheet (rect).
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { vi.restoreAllMocks() })
  const focused = (annoId: string) => ({ x: 0.5, y: 0.5, floor: 0, annoId, nonce: 1 })

  it('gives the selected Leitung its node grips while the surface is editable', () => {
    const { container } = renderPlan([line], { focus: focused('l1') })
    expect(container.querySelectorAll('.wb-vertex').length).toBeGreaterThan(0)
  })

  it('renders none of them read-only — no node, no «+», no Verlängern', () => {
    const { container } = renderPlan([line], { focus: focused('l1'), readOnly: true })
    expect(container.querySelectorAll('.wb-vertex')).toHaveLength(0)
    expect(container.querySelector('.wb-vins')).toBeNull()
    expect(container.querySelector('.wb-grow')).toBeNull()
  })

  it('writes nothing when a grip is dragged anyway (a stale handle, a synthetic event)', () => {
    const { container, onChange } = renderPlan([line], { focus: focused('l1') })
    const grip = container.querySelector('.wb-vertex')!
    cleanup()
    const locked = renderPlan([line], { focus: focused('l1'), readOnly: true })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grip, { clientX: 300, clientY: 300, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
    expect(locked.onChange).not.toHaveBeenCalled()
  })

  it('still opens the read-only editor — the EL may ask how long the Leitung is', () => {
    renderPlan([line], { focus: focused('l1'), readOnly: true })
    expect(screen.getByText(appConfig.copy.drawingEditor.drawing)).toBeTruthy()
    expect(screen.queryByRole('button', { name: W.dragVertex })).toBeNull()
  })
})

// ── A4 · Absperrkreis / Gefahrenradius on the Plan ──────────────────────────────────────────
// The one object type that existed on the Karte and nowhere else. A cordon is a POINT with an
// extent — centre plus a radius stored as a fraction of the plan width (types · BoardAnno.radiusN)
// — so it is placed, moved and sized by the Karte's own gestures, and only its metres wait for
// the sheet's Maßstab.
describe('the Absperrkreis on a plan', () => {
  const W = appConfig.copy.whiteboard
  const C = appConfig.drawing
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const cordon: BoardAnno = { id: 'k1', kind: 'circle', x: 0.5, y: 0.5, floor: 0, radiusN: 0.2, color: C.circleColor }
  const ink = (c: HTMLElement) => c.querySelector('.wb-ink')!
  const ring = (c: HTMLElement) => c.querySelector('.wb-ink-svg circle[style]')!
  const placed = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls[onChange.mock.calls.length - 1][0] as BoardAnno[]

  it('is dragged out from its centre, exactly like the Karte’s', () => {
    const { container, onChange } = renderPlan([])
    fireEvent.click(screen.getByRole('button', { name: 'Absperrkreis' }))
    const el = ink(container)
    fireEvent.pointerDown(el, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 300, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 300, clientY: 200, pointerId: 1 })
    const [a] = placed(onChange)
    expect(a).toMatchObject({ kind: 'circle', x: 0.5, y: 0.5, floor: 0 })
    expect(a.radiusN).toBeCloseTo(0.25, 6) // 100 of 400 px
  })

  it('drops a real cordon on a tap alone — the tool never does «nothing»', () => {
    const { container, onChange } = renderPlan([])
    fireEvent.click(screen.getByRole('button', { name: 'Absperrkreis' }))
    const el = ink(container)
    fireEvent.pointerDown(el, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 200, clientY: 200, pointerId: 1 })
    expect(placed(onChange)[0].radiusN).toBe(C.circleInitialRadiusN)
  })

  it('paints its ring and, once tapped, hands over the radius grip', () => {
    const { container } = renderPlan([cordon])
    expect(container.querySelectorAll('.wb-ink-svg circle').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: W.dragRadius })).toBeNull()
    fireEvent.pointerDown(ring(container), { clientX: 200, clientY: 200, pointerId: 1 })
    expect(screen.getByRole('button', { name: W.dragRadius })).toBeTruthy()
  })

  // a cordon is grabbed anywhere on its face, so the centre follows the DELTA — moving it to the
  // grab point would shift the ring out from under the hand
  it('moves by the pointer’s travel, not to the pointer', () => {
    const { container, onChange } = renderPlan([cordon])
    fireEvent.pointerDown(ring(container), { clientX: 280, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(ring(container), { clientX: 320, clientY: 200, pointerId: 1 })
    const [a] = placed(onChange)
    expect(a.x).toBeCloseTo(0.6, 6) // 0.5 + 40/400
    expect(a.y).toBeCloseTo(0.5, 6)
  })

  it('states no metres on an uncalibrated sheet — that would be a number nobody measured', () => {
    const { container } = renderPlan([cordon])
    expect(container.querySelector('.wb-line-label')).toBeNull()
  })

  it('states its radius once the sheet is calibrated against its Maßstab', () => {
    // ar matches the landscape A4 the blank Tafel is measured at (1 / (1 / 1.414))
    const { container } = renderPlan([cordon], { planScale: { tafel: { mPerU: 100, refM: 10, ar: 1.414 } } })
    expect(container.querySelector('.wb-line-label')?.textContent).toMatch(/m$/)
  })

  it('never wears vertex grips — it is centre + radius, not a polyline', () => {
    const { container } = renderPlan([cordon])
    fireEvent.pointerDown(ring(container), { clientX: 200, clientY: 200, pointerId: 1 })
    expect(container.querySelectorAll('.wb-vertex')).toHaveLength(1) // the radius grip, nothing else
    expect(container.querySelector('.wb-vins')).toBeNull()
  })
})

// ── A8 · the placement magnet holds the board still ─────────────────────────────────────────
// The Karte pauses dragPan while a claim ring fills, with the reason written out (MapView ·
// placePanPaused): a finger holding still for the dwell wobbles past the pan slop, the pan that
// starts kills the claim AND eats the tap, and the ring can never be ridden to the end on a real
// device. The Plan kept its 8 px tap threshold live through the very same moment.
describe('the Rotation’s placement magnet pauses the board pan', () => {
  const S = appConfig.copy.shapes
  const symApi: SymbolsApi = {
    ready: true, error: false, reload: () => {}, order: ['Gefahren'],
    symbols: [{ cat: 'Gefahren', name: 'VKF Feuer', svg: '<svg viewBox="0 0 10 10"></svg>' }],
    byName: { 'VKF Feuer': '<svg viewBox="0 0 10 10"></svg>' },
  }
  const target: BoardAnno = { id: 's1', kind: 'symbol', x: 0.5, y: 0.5, floor: 0, symbol: 'VKF Feuer' }
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const armRotation = () => {
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.whiteboard.symbol }))
    fireEvent.click(screen.getByRole('button', { name: S.names.rotation }))
  }
  const shapes = (onChange: ReturnType<typeof vi.fn>) => {
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]
    return ((last?.[0] ?? []) as BoardAnno[]).filter((a) => a.kind === 'shape')
  }

  it('rides a 9 px glove wobble on the target and still lays the point down', () => {
    const { container, onChange } = renderPlan([target], { sym: symApi })
    armRotation()
    const el = container.querySelector('.wb-ink')!
    // dead on the symbol (0.5/0.5 of a 400 px sheet), then the wobble the ring is meant to absorb
    fireEvent.pointerDown(el, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 209, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 209, clientY: 200, pointerId: 1 })
    // the second point finishes the run — it only exists if the first tap survived the wobble
    fireEvent.pointerDown(el, { clientX: 340, clientY: 340, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 340, clientY: 340, pointerId: 1 })
    expect(shapes(onChange)).toHaveLength(1)
  })

  it('still lets a deliberate drag off the ring pan and lay nothing down', () => {
    const { container, onChange } = renderPlan([target], { sym: symApi })
    armRotation()
    const el = container.querySelector('.wb-ink')!
    fireEvent.pointerDown(el, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 380, clientY: 200, pointerId: 1 }) // well out of the ring
    fireEvent.pointerUp(el, { clientX: 380, clientY: 200, pointerId: 1 })
    fireEvent.pointerDown(el, { clientX: 340, clientY: 340, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 340, clientY: 340, pointerId: 1 })
    expect(shapes(onChange)).toHaveLength(0) // that second tap is only the FIRST point now
  })
})

// ── the Rotation on the Kroki ────────────────────────────────────────────────────────────────
// Its box and its chrome, the halves of «Klickfläche wie beim Rechteck» and «gleiche Griffe wie
// bei der Fläche». The pad's own pixels are CSS (03-map.css · .shape-glyph::before, shared with
// the Karte); what the surface owes it is the two-sided box to hug.
describe('a Rotation on the plan sheet', () => {
  const S = appConfig.copy.shapes
  // a run stored the way both surfaces store one (lib/shapes · rotationBox)
  const loop: BoardAnno = { id: 'r1', kind: 'shape', shape: 'rotation', x: 0.5, y: 0.5, sizeN: 0.42, aspect: 0.13, rotation: 25, floor: 0 }
  const rect: BoardAnno = { id: 'q1', kind: 'shape', shape: 'square', x: 0.3, y: 0.3, sizeN: 0.1, floor: 0 }

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('draws the same pad host the Rechteck has — its own box, on its own bearing', () => {
    const { container } = renderPlan([rect])
    const sq = container.querySelector<HTMLElement>('.shape-glyph')!
    expect(parseFloat(sq.style.height)).toBeCloseTo(parseFloat(sq.style.width), 6)
    cleanup()
    const { container: c2 } = renderPlan([loop])
    const rot = c2.querySelector<HTMLElement>('.shape-glyph')!
    expect(parseFloat(rot.style.height)).toBeCloseTo(parseFloat(rot.style.width) * 0.13, 3)
    expect(rot.style.transform).toContain('rotate(25deg)')
  })

  // 01.09. vocabulary: on the object itself only GEOMETRY grips, and every one of them blue.
  // A Rotation is its two ends — each sets the run's length AND its bearing — so it carries no
  // rotate knob, no stem and no size grip; moving and turning the whole loop is the fixed bar's.
  it('wears its two end grips and nothing else — no knob, no stem, no size grip', () => {
    const { container } = renderPlan([loop])
    fireEvent.pointerDown(container.querySelector('.wb-shape')!)
    const ends = container.querySelectorAll('.handle.shape-end')
    expect(ends).toHaveLength(2)
    for (const g of ends) {
      expect(g.getAttribute('aria-label')).toBe(S.endHint)
      expect(g.hasAttribute('data-holdaction')).toBe(true)
    }
    expect(container.querySelector('.shape-stem')).toBeNull()
    expect(container.querySelector('.shape-rotate')).toBeNull()
    expect(container.querySelector('.shape-resize, .shape-width')).toBeNull()
    // …and no grip paints itself: the blue is the shared .shape-end rule, never an inline fill
    for (const g of ends) expect((g as HTMLElement).style.background).toBe('')
  })

})

// ── the fixed selection bar (components/SelectionBar) ────────────────────────────────────────
// It replaced the group pill AND the map's floating hub on 01.09.: one bar, in one place, for a
// single Linie, an Absperrkreis, a Form and a Mehrfach group alike.
describe('the plan’s selection bar', () => {
  const D = appConfig.copy.drawingEditor
  const R = appConfig.copy.shapes.rotate
  const bar = () => screen.queryByRole('toolbar', { name: D.selectionBar })
  const circle: BoardAnno = { id: 'k1', kind: 'circle', x: 0.5, y: 0.5, radiusN: 0.2, floor: 0 }
  const box: BoardAnno = { id: 'f1', kind: 'shape', shape: 'square', x: 0.3, y: 0.3, sizeN: 0.1, floor: 0, rotation: 10 }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('is absent until something is selected, then carries ✥ · ⟳ · Löschen', () => {
    const { container } = renderPlan([line])
    expect(bar()).toBeNull()
    fireEvent.pointerDown(hitShape(container))
    expect(bar()).toBeTruthy()
    expect(within(bar()!).getByRole('button', { name: D.move })).toBeTruthy()
    expect(within(bar()!).getByRole('button', { name: R })).toBeTruthy()
  })

  it('moves the whole selection by the ✥ drag, in one undo step', () => {
    const { container, onChange } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    const grip = within(bar()!).getByRole('button', { name: D.move })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grip, { clientX: 180, clientY: 100, pointerId: 1 }) // +80px of a 400px board
    fireEvent.pointerUp(grip, { clientX: 180, clientY: 100, pointerId: 1 })
    const moved = onChange.mock.calls[onChange.mock.calls.length - 1][0].find((a: BoardAnno) => a.id === 'l1')
    expect(moved.pts[0][0]).toBeCloseTo(0.4) // 0.2 + 80/400
    expect(moved.pts[1][0]).toBeCloseTo(1.0)
    expect(moved.pts[0][1]).toBeCloseTo(0.2) // untouched across
  })

  it('turns a Form about the selection centre and its own bearing with it', () => {
    const { container, onChange } = renderPlan([box])
    fireEvent.pointerDown(container.querySelector('.wb-shape')!)
    // the Form keeps its own knob on the glyph; the bar's is the one in the toolbar
    const dialBtn = within(bar()!).getByRole('button', { name: R })
    fireEvent.pointerDown(dialBtn, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(dialBtn, { clientX: 380, clientY: 200, pointerId: 1 }) // 180px = +90°
    fireEvent.pointerUp(dialBtn, { clientX: 380, clientY: 200, pointerId: 1 })
    const turned = onChange.mock.calls[onChange.mock.calls.length - 1][0].find((a: BoardAnno) => a.id === 'f1')
    expect(turned.rotation).toBe(100) // 10° + 90°
    // a single object turns about ITSELF, so it stays where it was
    expect(turned.x).toBeCloseTo(0.3)
    expect(turned.y).toBeCloseTo(0.3)
  })

  /**
   * ⚠️ 02.09., in lockstep with the Karte: a selected Form wears no halo and its body drags
   * nothing. Its grips are the precise ones; moving the whole thing is the bar's ✥, dragged for
   * the small adjustment or armed for the whole sheet. A body drag meant a reach for an end grip
   * that landed a few pixels short pulled the loop away instead.
   */
  it('gives a selected Form no halo, and no body drag either', () => {
    const { container, onChange } = renderPlan([box])
    const glyph = container.querySelector('.wb-shape')!
    fireEvent.pointerDown(glyph, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(container.querySelector('.sel-halo')).toBeNull()
    fireEvent.pointerMove(glyph, { pointerId: 1, clientX: 200, clientY: 180 })
    fireEvent.pointerUp(glyph, { pointerId: 1, clientX: 200, clientY: 180 })
    const out = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as BoardAnno[] | undefined
    expect(out?.find((a) => a.id === 'f1')?.x ?? 0.3).toBeCloseTo(0.3)
  })

  it('…while a placed symbol keeps its halo and its body drag', () => {
    const sym: BoardAnno = { id: 'y1', kind: 'symbol', symbol: 'Feuer', x: 0.3, y: 0.3, floor: 0 }
    const { container, onChange } = renderPlan([sym])
    const chip = container.querySelector('.wb-anno')!
    fireEvent.pointerDown(chip, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(container.querySelector('.sel-halo')).toBeTruthy()
    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 200, clientY: 100 })
    const out = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as BoardAnno[] | undefined
    expect(out?.find((a) => a.id === 'y1')?.x ?? 0.3).toBeGreaterThan(0.3)
  })

  it('offers no ⟳ for an Absperrkreis — a centre and a radius have no angle', () => {
    const { container } = renderPlan([circle])
    fireEvent.pointerDown(container.querySelector('.wb-ink-svg circle[style]')!)
    expect(bar()).toBeTruthy()
    expect(within(bar()!).queryByRole('button', { name: R })).toBeNull()
  })

  // ── ✥ / ⟳ as tap-toggles (02.09.) ───────────────────────────────────────────────────────
  // The bar is pinned bottom-centre, so pulling ✥ DOWN runs the finger off the screen. A tap
  // arms the same writers for the whole sheet instead (lib/useArmedTransform).
  it('arms ✥ on a tap, then moves the selection from a drag on the paper itself', () => {
    const { container, onChange } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    const grip = within(bar()!).getByRole('button', { name: D.move })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(within(bar()!).getByRole('button', { name: D.moveArmed }).getAttribute('aria-pressed')).toBe('true')
    // …now a drag anywhere, including straight DOWN, which the grip had no room for
    const canvas = container.querySelector('.wb-canvas')!
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 2, isPrimary: true })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 160, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 40, clientY: 160, pointerId: 2 })
    const moved = onChange.mock.calls[onChange.mock.calls.length - 1][0].find((a: BoardAnno) => a.id === 'l1')
    expect(moved.pts[0][1]).toBeCloseTo(0.5)   // 0.2 + 120/400
    expect(moved.pts[0][0]).toBeCloseTo(0.2)   // untouched across
  })

  it('turns the selection about its centre while ⟳ is armed, following the pointer', () => {
    const { container, onChange } = renderPlan([box])
    fireEvent.pointerDown(container.querySelector('.wb-shape')!)
    const dialBtn = within(bar()!).getByRole('button', { name: R })
    fireEvent.pointerDown(dialBtn, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(dialBtn, { clientX: 100, clientY: 100, pointerId: 1 })
    // the Form sits at (0.3, 0.3) of a 400px board → its centre is client (120, 120)
    const canvas = container.querySelector('.wb-canvas')!
    fireEvent.pointerDown(canvas, { clientX: 220, clientY: 120, pointerId: 2, isPrimary: true }) // due east
    fireEvent.pointerMove(window, { clientX: 120, clientY: 220, pointerId: 2 })                  // due south
    fireEvent.pointerUp(window, { clientX: 120, clientY: 220, pointerId: 2 })
    const turned = onChange.mock.calls[onChange.mock.calls.length - 1][0].find((a: BoardAnno) => a.id === 'f1')
    expect(turned.rotation).toBe(100)          // 10° + a quarter turn clockwise
  })

  it('keeps the selection under a tap that never travels while armed', () => {
    const { container } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    const grip = within(bar()!).getByRole('button', { name: D.move })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    const canvas = container.querySelector('.wb-canvas')!
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 2, isPrimary: true })
    fireEvent.pointerUp(window, { clientX: 40, clientY: 40, pointerId: 2 })
    fireEvent.click(canvas)
    // an empty-paper press normally clears the selection; while armed it is simply nothing
    expect(bar()).toBeTruthy()
    expect(within(bar()!).getByRole('button', { name: D.moveArmed })).toBeTruthy()
  })

  // ⚠️ «Löschen» left the bar on 02.09.: its third slot is «Fertig», which ENDS the editing state
  // — nothing selected, no mode armed, the sheets that were open for it closed. Deleting stays on
  // the Delete key and in the object's own editor sheet (see the A21 block below).
  it('ends the editing state on «Fertig», and offers no trash at all', () => {
    const { container, onChange } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    expect(within(bar()!).queryByRole('button', { name: appConfig.copy.delete })).toBeNull()
    fireEvent.click(within(bar()!).getByRole('button', { name: appConfig.copy.done }))
    expect(bar()).toBeNull()
    // …and it deletes nothing on the way out
    expect(onChange.mock.calls.length === 0
      || onChange.mock.calls[onChange.mock.calls.length - 1][0].some((a: BoardAnno) => a.id === 'l1')).toBe(true)
  })

  it('drops an armed mode with the editing state', () => {
    const { container, onChange } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    const grip = within(bar()!).getByRole('button', { name: D.move })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(within(bar()!).getByRole('button', { name: D.moveArmed })).toBeTruthy()
    fireEvent.click(within(bar()!).getByRole('button', { name: appConfig.copy.done }))
    expect(bar()).toBeNull()
    // …and a drag on the sheet is a plain board gesture again, not a move of what was selected
    const canvas = container.querySelector('.wb-canvas')!
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 2, isPrimary: true })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 160, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 40, clientY: 160, pointerId: 2 })
    const out = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as BoardAnno[] | undefined
    expect(out?.find((a) => a.id === 'l1')?.pts?.[0][1] ?? 0.2).toBeCloseTo(0.2)
  })

  it('is the SAME bar for a Mehrfach group — one drag moves every boxed object', () => {
    const { container, onChange } = renderPlan([line, box])
    fireEvent.click(screen.getByRole('button', { name: 'Mehrfach' }))
    const stage = container.querySelector('.wb-stage > div')!
    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    expect(bar()).toBeTruthy()
    const grip = within(bar()!).getByRole('button', { name: D.move })
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(grip, { clientX: 100, clientY: 140, pointerId: 2 }) // +40px down of 400
    fireEvent.pointerUp(grip, { clientX: 100, clientY: 140, pointerId: 2 })
    const out = onChange.mock.calls[onChange.mock.calls.length - 1][0] as BoardAnno[]
    expect(out.find((a) => a.id === 'l1')!.pts![0][1]).toBeCloseTo(0.3) // 0.2 + 40/400
    expect(out.find((a) => a.id === 'f1')!.y).toBeCloseTo(0.4)          // 0.3 + 40/400
  })

  it('hands out no bar at all on a read-only surface', () => {
    renderPlan([line], { readOnly: true, focus: { x: 0.5, y: 0.5, floor: 0, annoId: 'l1', nonce: 1 } })
    expect(bar()).toBeNull()
  })

  // ── A21 · Delete / Backspace ───────────────────────────────────────────────────────────────
  // The Karte has bound the key since the beginning; the Kroki had only Escape. Same semantics,
  // reaching for exactly what the bar's trash reaches for.
  const press = (key: 'Delete' | 'Backspace', target: Element | Window = window) => fireEvent.keyDown(target, { key })
  const survives = (onChange: ReturnType<typeof vi.fn>, id: string) =>
    onChange.mock.calls.length === 0 || onChange.mock.calls[onChange.mock.calls.length - 1][0].some((a: BoardAnno) => a.id === id)

  it('deletes the selection by Delete, and by Backspace', () => {
    for (const key of ['Delete', 'Backspace'] as const) {
      const { container, onChange } = renderPlan([line])
      fireEvent.pointerDown(hitShape(container))
      press(key)
      expect(survives(onChange, 'l1')).toBe(false)
      cleanup()
    }
  })

  it('deletes a whole Mehrfach group by the key, exactly as a single object goes', () => {
    const { container, onChange } = renderPlan([line, box])
    fireEvent.click(screen.getByRole('button', { name: 'Mehrfach' }))
    const stage = container.querySelector('.wb-stage > div')!
    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    press('Delete')
    expect(survives(onChange, 'l1')).toBe(false)
    expect(survives(onChange, 'f1')).toBe(false)
  })

  // ⚠️ The one that matters on a sheet full of Notiz textareas and Trupp names: Backspace in a
  // field is a character, never a delete.
  it('stays out of the way while a field owns the press', () => {
    const { container, onChange } = renderPlan([line])
    fireEvent.pointerDown(hitShape(container))
    const field = document.createElement('input')
    container.appendChild(field)
    press('Backspace', field)
    expect(survives(onChange, 'l1')).toBe(true)
  })

  it('deletes nothing on a read-only surface', () => {
    const { onChange } = renderPlan([line], { readOnly: true, focus: { x: 0.5, y: 0.5, floor: 0, annoId: 'l1', nonce: 1 } })
    press('Delete')
    expect(survives(onChange, 'l1')).toBe(true)
  })

  // ── A22 · Cmd/Ctrl+D ───────────────────────────────────────────────────────────────────────
  // The key resolved on the Plan and then did nothing (lib/hotkeys decodes it surface-agnostically;
  // IncidentWorkspace only dispatched it on the Karte). Same semantics as the map's here.
  type Keys = NonNullable<React.ComponentProps<typeof Whiteboard>['keysRef']>
  const withKeys = (annos: BoardAnno[], extra: Partial<React.ComponentProps<typeof Whiteboard>> = {}) => {
    const keysRef: Keys = { current: null }
    const log = vi.fn()
    return { ...renderPlan(annos, { keysRef, log, ...extra }), keysRef, log }
  }
  const out = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls[onChange.mock.calls.length - 1][0] as BoardAnno[]

  it('duplicates the one selected object a visible nudge away, and selects the copy', () => {
    const { container, onChange, keysRef, log } = withKeys([line])
    fireEvent.pointerDown(hitShape(container))
    act(() => { keysRef.current!.duplicate() })
    const annos = out(onChange)
    expect(annos).toHaveLength(2)
    const copy = annos.find((a) => a.id !== 'l1')!
    expect(copy.kind).toBe('draw')
    expect(copy.pts![0][0]).toBeCloseTo(0.22) // 0.2 + DUP_OFFSET_N
    expect(copy.pts![0][1]).toBeCloseTo(0.22)
    // one «Objekt dupliziert» row, pointing at the COPY — which is also what the selection
    // moved to (setSelId). ⚠️ `annos` is a controlled prop here, so the copy never comes back
    // into this render; the journal row is what says which object the surface handed on to.
    expect(log).toHaveBeenCalledWith('layers', appConfig.copy.log.duplicated, expect.objectContaining({ annoId: copy.id }))
  })

  // ⚠️ A recorded track belongs to the Trupp that walked it (`teamLocked` refuses to delete one),
  // so a copy that inherited it would fabricate a movement history AND arrive undeletable.
  it('never copies a Trupp’s recorded trail', () => {
    const trupp: BoardAnno = { id: 'r1', kind: 'resource', x: 0.5, y: 0.5, floor: 0, text: 'A1', trail: [{ x: 0.1, y: 0.1, floor: 0, t: '2026-09-02T08:00:00Z' }] }
    const { container, onChange, keysRef } = withKeys([trupp])
    fireEvent.pointerDown(container.querySelector('.wb-anno')!)
    act(() => { keysRef.current!.duplicate() })
    const copy = out(onChange).find((a) => a.id !== 'r1')!
    expect(copy.trail).toBeUndefined()
  })

  it('stays out of a Mehrfach group and off a read-only sheet — as on the Karte', () => {
    const { container, onChange, keysRef } = withKeys([line, box])
    fireEvent.click(screen.getByRole('button', { name: 'Mehrfach' }))
    const stage = container.querySelector('.wb-stage > div')!
    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: 400, clientY: 400, pointerId: 1 })
    act(() => { keysRef.current!.duplicate() })
    expect(onChange).not.toHaveBeenCalled()

    cleanup()
    const ro = withKeys([line], { readOnly: true, focus: { x: 0.5, y: 0.5, floor: 0, annoId: 'l1', nonce: 1 } })
    act(() => { ro.keysRef.current!.duplicate() })
    expect(ro.onChange).not.toHaveBeenCalled()
  })
})
