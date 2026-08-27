// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const sym: SymbolsApi = { ready: false, order: [], symbols: [], byName: {} }
// an annotation somebody drew on the Umrisse sheet BEFORE it became selection-only
const oldNote: BoardAnno = { id: 'a1', kind: 'text', x: 0.4, y: 0.4, floor: 0, text: 'Alte Notiz' }

const gebaeudeDoc: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Geschosse (Skizze)', subtitle: '', imageUrl: '',
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
