// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMapDrawing } from './useMapDrawing'
import type { Doc } from './workspace'
import type { Drawing } from '../types'

// The two mutating behaviours this wave added to the map drawing surface:
//  · C1 — a SEMANTIC edit (Leitung Nr., Stockwerk, Abschluss) earns ONE settled Verlauf row per
//    burst, while colour/width/dash stay silent by doctrine (lib/drawingEdit).
//  · A6 — tap-away mid-draft no longer discards silently: a committable draft auto-commits with
//    an undo that returns the shape TO THE HAND; a fragment says it was discarded.

vi.mock('./ui', () => ({ toast: vi.fn(), confirmDialog: vi.fn() }))
import { toast } from './ui'

const line = (over: Partial<Drawing> = {}): Drawing =>
  ({ id: 'd1', kind: 'line', coords: [[7.7, 47.4], [7.8, 47.5]], ...over }) as Drawing

function makeDeps(over: { tool?: string; tacticalLocked?: boolean; drawings?: Drawing[] } = {}) {
  // a live doc the commit stub actually applies to, so a burst's second patch sees the first
  let doc = { entities: [], drawings: over.drawings ?? [line()] } as unknown as Doc
  const deps = {
    drawings: doc.drawings,
    selectedDrawingId: 'd1' as string | null,
    tacticalLocked: over.tacticalLocked ?? false,
    tool: over.tool ?? 'select',
    setTool: vi.fn(),
    commit: vi.fn((u: (d: Doc) => Doc, _opts?: { gesture?: boolean }) => { void _opts; doc = u(doc); deps.drawings = doc.drawings }),
    setDocRaw: vi.fn(),
    beginDrag: vi.fn(),
    endDrag: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    setSelectedDrawingId: vi.fn(),
    setSelectedId: vi.fn(),
    setSelectedDrawIds: vi.fn(),
    setSelectedEntityIds: vi.fn(),
  }
  return deps
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('noteDrawingEdit via patchDrawing (C1)', () => {
  it('folds a burst of semantic edits into ONE row naming every change', () => {
    const deps = makeDeps()
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.patchDrawing({ lineNo: 3 }) })
    rerender({ ...deps }) // the commit landed — the next patch reads the patched drawing
    act(() => { result.current.patchDrawing({ floorTag: 2 }) })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(deps.log).toHaveBeenCalledTimes(1)
    const text = deps.log.mock.calls[0][1] as string
    expect(text).toContain('Leitung Nr.: 3')
    expect(text).toContain('Geschoss')
  })

  it('colour/width/dash stay silent — arranging the picture is not an event', () => {
    const deps = makeDeps()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.patchDrawing({ color: '#f00', width: 6, dashed: true }) })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(deps.log).not.toHaveBeenCalled()
  })

  it('the exported noteDrawingEdit covers hand-rolled commits (changeMapEnding)', () => {
    const deps = makeDeps()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.noteDrawingEdit(line(), { teilstueck: true }) })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(deps.log).toHaveBeenCalledTimes(1)
    expect(deps.log.mock.calls[0][1]).toContain('Abschluss')
  })
})

describe('settleDraft (A6)', () => {
  it('auto-commits a committable area draft WITHOUT stealing the selection, with an undo toast', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    const ring: [number, number][] = [[7.7, 47.4], [7.8, 47.4], [7.8, 47.5]]
    act(() => { result.current.setDraft(ring) })
    act(() => { result.current.settleDraft() })
    // committed through the ordinary create funnel (one commit, the areaDrawn row)…
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.drawings.some((d) => d.kind === 'area')).toBe(true)
    // …but the tap-away target keeps its selection — nothing here re-selects
    expect(deps.setSelectedDrawingId).not.toHaveBeenCalled()
    expect(deps.setTool).not.toHaveBeenCalled()
    const [text, opts] = (toast as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(text).toContain('gespeichert')
    expect(opts.action.label).toBe('Rückgängig')
    expect(result.current.draft).toEqual([])
  })

  it('undo returns the shape to the hand: drawing out, draft points back, tool re-armed', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    const ring: [number, number][] = [[7.7, 47.4], [7.8, 47.4], [7.8, 47.5]]
    act(() => { result.current.setDraft(ring) })
    act(() => { result.current.settleDraft() })
    const opts = (toast as ReturnType<typeof vi.fn>).mock.calls[0][1]
    act(() => { opts.action.onClick() })
    rerender({ ...deps })
    expect(deps.drawings.some((d) => d.kind === 'area')).toBe(false)
    expect(deps.setTool).toHaveBeenCalledWith('area')
    expect(result.current.draft).toEqual(ring)
    // the record stays truthful — created, then taken back, named like its creation row
    expect(deps.log.mock.calls.map((c) => c[1])).toContain('Fläche entfernt')
  })

  it('a fragment below the minimum is discarded OUT LOUD, never silently', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setDraft([[7.7, 47.4], [7.8, 47.4]]) }) // 2 points — no area yet
    act(() => { result.current.settleDraft() })
    expect(deps.commit).not.toHaveBeenCalled()
    const [text, opts] = (toast as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(text).toContain('verworfen')
    expect(opts?.action).toBeUndefined()
    expect(result.current.draft).toEqual([])
  })

  it('under the tactical lock nothing may be written — the draft is discarded, said out loud', () => {
    const deps = makeDeps({ tool: 'area', tacticalLocked: true })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setDraft([[7.7, 47.4], [7.8, 47.4], [7.8, 47.5]]) })
    act(() => { result.current.settleDraft() })
    expect(deps.commit).not.toHaveBeenCalled()
    expect((toast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('verworfen')
  })

  it('an empty draft is a no-op — no toast for a tap-away with nothing in hand', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.settleDraft() })
    expect(toast).not.toHaveBeenCalled()
  })
})

// One drag gesture, two outcomes: which tool is armed decides whether the path closes into a
// Fläche or stays a Linie. Freehand areas exist for the shape a tapped polygon cannot follow —
// a fire's edge (FKS Vegetationsbrand · «vorsehbare Brandentwicklung»).
describe('freehand: the armed tool decides what the stroke becomes', () => {
  const stroke: [number, number][] = [[7.70, 47.40], [7.72, 47.42], [7.74, 47.40], [7.71, 47.39]]

  it('closes a dragged path into a Fläche while the area tool is armed', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.onFreehand(stroke) })
    const added = deps.commit.mock.calls.length ? deps.drawings[deps.drawings.length - 1] : undefined
    expect(added?.kind).toBe('area')
    expect(added?.coords).toEqual(stroke)
  })

  it('still draws a Linie while the line tool is armed', () => {
    const deps = makeDeps({ tool: 'line' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.onFreehand(stroke) })
    expect(deps.drawings[deps.drawings.length - 1]?.kind).toBe('line')
  })

  // a ring needs three points; two are a line the operator drew by accident with the wrong tool
  it('refuses a stroke too short to be a ring', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.onFreehand([[7.7, 47.4], [7.71, 47.41]]) })
    expect(deps.commit).not.toHaveBeenCalled()
  })

  it('the ✓ button belongs to node mode — a freehand area has nothing to confirm', () => {
    const deps = makeDeps({ tool: 'area' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setDraft([[7.7, 47.4], [7.8, 47.4], [7.8, 47.5]]) })
    expect(result.current.draftActive).toBe(true)
    act(() => { result.current.setAreaMode('freehand') })
    expect(result.current.draftActive).toBe(false)
    expect(result.current.freehandKind).toBe('area')
  })

  // A7 · the surface has to know WHICH shape the drag lays down, because only a Leitung's ends
  // can carry an attachment — MapView raises the endpoint magnet for a 'line' and for nothing else.
  it('names the freehand kind, so an area stroke can be told from a line stroke', () => {
    const deps = makeDeps({ tool: 'line' })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    expect(result.current.freehandKind).toBe('line')
    act(() => { result.current.setLineMode('nodes') })
    expect(result.current.freehandKind).toBe(null)
  })
})

// Vertex insert/delete are DISCRETE edits: each is one commit (one undo step on the Karte's
// document) and one draw.edit — and the delete refuses to take a shape below what it needs to
// stay drawable (a Linie keeps 2 points, a Fläche 3). Pinned before the vertex rules move to
// one shared module, so the move cannot shift an index or a threshold.
describe('insertDrawingVertex / deleteDrawingVertex', () => {
  const area = (): Drawing => ({ id: 'a1', kind: 'area', coords: [[0, 0], [1, 0], [1, 1]] }) as Drawing

  it('inserts AT the index (splice), as one commit and one draw.edit', () => {
    const deps = makeDeps()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.insertDrawingVertex('d1', 1, [7.75, 47.45]) })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.drawings[0].coords).toEqual([[7.7, 47.4], [7.75, 47.45], [7.8, 47.5]])
    expect(deps.emit).toHaveBeenCalledTimes(1)
    expect(deps.emit).toHaveBeenCalledWith('draw.edit', { id: 'd1', patch: { coords: [[7.7, 47.4], [7.75, 47.45], [7.8, 47.5]] } })
  })

  it('inserting at index 0 prepends, at length appends', () => {
    const deps = makeDeps()
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.insertDrawingVertex('d1', 0, [7.6, 47.3]) })
    rerender({ ...deps })
    act(() => { result.current.insertDrawingVertex('d1', 3, [7.9, 47.6]) })
    expect(deps.drawings[0].coords).toEqual([[7.6, 47.3], [7.7, 47.4], [7.8, 47.5], [7.9, 47.6]])
    expect(deps.commit).toHaveBeenCalledTimes(2)
  })

  it('deletes a vertex of a 3-point line — one commit, one draw.edit', () => {
    const deps = makeDeps()
    deps.drawings = [line({ coords: [[0, 0], [1, 1], [2, 2]] })]
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.deleteDrawingVertex('d1', 1) })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.emit).toHaveBeenCalledWith('draw.edit', { id: 'd1', patch: { coords: [[0, 0], [2, 2]] } })
  })

  it('refuses at the minimum — a Linie keeps 2 points', () => {
    const deps = makeDeps()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.deleteDrawingVertex('d1', 0) })
    expect(deps.commit).not.toHaveBeenCalled()
    expect(deps.emit).not.toHaveBeenCalled()
  })

  it('refuses at the minimum — a Fläche keeps 3 points, and a 4th may go', () => {
    const deps = makeDeps()
    deps.drawings = [area()]
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.deleteDrawingVertex('a1', 0) })
    expect(deps.commit).not.toHaveBeenCalled()
    deps.drawings = [{ ...area(), coords: [[0, 0], [1, 0], [1, 1], [0, 1]] }]
    rerender({ ...deps })
    act(() => { result.current.deleteDrawingVertex('a1', 3) })
    expect(deps.emit).toHaveBeenCalledWith('draw.edit', { id: 'a1', patch: { coords: [[0, 0], [1, 0], [1, 1]] } })
  })

  it('both are no-ops under the tactical lock', () => {
    const deps = makeDeps({ tacticalLocked: true })
    deps.drawings = [line({ coords: [[0, 0], [1, 1], [2, 2]] })]
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.insertDrawingVertex('d1', 1, [0.5, 0.5]) })
    act(() => { result.current.deleteDrawingVertex('d1', 1) })
    expect(deps.commit).not.toHaveBeenCalled()
    expect(deps.emit).not.toHaveBeenCalled()
  })

  it('an unknown id is a no-op', () => {
    const deps = makeDeps()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.insertDrawingVertex('nope', 0, [0, 0]) })
    act(() => { result.current.deleteDrawingVertex('nope', 0) })
    expect(deps.commit).not.toHaveBeenCalled()
  })
})

// The draft thresholds: ✓ lights at 2 node-line points / 3 area points, and commitDraft
// creates exactly then (below it, the draft is simply cleared).
describe('draft thresholds', () => {
  it('draftActive: a node line at 2 points, an area at 3', () => {
    const deps = makeDeps({ tool: 'line' })
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setLineMode('nodes') })
    act(() => { result.current.setDraft([[0, 0]]) })
    expect(result.current.draftActive).toBe(false)
    act(() => { result.current.setDraft([[0, 0], [1, 1]]) })
    expect(result.current.draftActive).toBe(true)
    rerender({ ...deps, tool: 'area' })
    expect(result.current.draftActive).toBe(false)
    act(() => { result.current.setDraft([[0, 0], [1, 1], [1, 0]]) })
    expect(result.current.draftActive).toBe(true)
  })

  it('commitDraft: a line from 2 points, an area only from 3', () => {
    const deps = makeDeps({ tool: 'line' })
    const { result, rerender } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setDraft([[0, 0]]) })
    act(() => { result.current.commitDraft() })
    expect(deps.commit).not.toHaveBeenCalled()
    expect(result.current.draft).toEqual([])
    act(() => { result.current.setDraft([[0, 0], [1, 1]]) })
    act(() => { result.current.commitDraft() })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    rerender({ ...deps, tool: 'area' })
    act(() => { result.current.setDraft([[0, 0], [1, 1]]) })
    act(() => { result.current.commitDraft() })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    act(() => { result.current.setDraft([[0, 0], [1, 1], [1, 0]]) })
    act(() => { result.current.commitDraft() })
    expect(deps.commit).toHaveBeenCalledTimes(2)
  })
})

// D3 (24.09.2026): «Am Einsatzort» lets go on site, «Zurück auf Stand am Einsatzort» is one step
// with one row, and a traced hose may be kept («Hier lösen (Spur behalten)», a drag-off). The Übung
// on 23.09.2026 saved a depot → site → depot hose line because «Weiter folgen» overwrote the
// on-site point and «Hier lösen» cut at the vehicle's current position without saying so.
describe('GPS ends: «Zurück», «Am Einsatzort lösen», «Hier lösen», drag-off', () => {
  const SITE: [number, number] = [8.0, 47.0]
  const DEPOT: [number, number] = [8.01, 47.007]
  const onSite: [number, number][] = [[7.9993, 46.9996], [7.9997, 46.9998], SITE]
  const followed = (over: Partial<Drawing> = {}): Drawing => line({
    // the line after following the TLF to its depot: the drive is its tail
    coords: [[7.9993, 46.9996], [7.9997, 46.9998], [8.003, 47.002], [8.007, 47.005], DEPOT],
    endAttachment: {
      target: { kind: 'object', id: 'gps-3', live: true }, routing: 'trace',
      gps: { state: 'continuous', confirmedAt: SITE, lastSafe: DEPOT, before: { coords: onSite, routing: 'direct', state: 'paused', confirmedAt: SITE, lastSafe: SITE, at: '2026-09-23T20:31:00.000Z' } },
    },
    ...over,
  })
  const ROW = 'Leitung 1: zurück auf Stand am Einsatzort (20:31), von TLF gelöst'

  it('«Zurück»: ONE step, NOT a hand gesture, the snapshot exactly, the end detached, ONE Verlauf row, a coherent replay pair', () => {
    const deps = makeDeps({ drawings: [followed()] })
    const onLineDetached = vi.fn()
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: { ...deps, onLineDetached } })
    let ok = false
    act(() => { ok = result.current.revertGpsFollow([{ id: 'd1', endpoint: 'end' }], ROW) })
    expect(ok).toBe(true)
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.commit.mock.calls[0][1]).toEqual({ gesture: false }) // a plan-drawn hose keeps its sheet
    expect(deps.drawings[0].coords).toEqual(onSite)
    expect(deps.drawings[0].endAttachment).toBeUndefined() // and gps.before with it
    expect(deps.log).toHaveBeenCalledTimes(1)
    expect(deps.log.mock.calls[0][1]).toBe(ROW)
    expect(deps.emit.mock.calls.map((c) => c[0])).toEqual(['draw.edit', 'draw.detach'])
    expect(deps.emit.mock.calls[1][1]).toMatchObject({ id: 'd1', endpoint: 'end', fallback: SITE })
    expect(onLineDetached).toHaveBeenCalledTimes(1)
  })

  it('«Zurück» on TWO hoses of one TLF: one step, one row', () => {
    const deps = makeDeps({ drawings: [followed(), followed({ id: 'd2' })] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.revertGpsFollow([{ id: 'd1', endpoint: 'end' }, { id: 'd2', endpoint: 'end' }], 'x') })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledTimes(1)
    expect(deps.drawings.map((d) => d.coords)).toEqual([onSite, onSite])
  })

  it('«Zurück» without a snapshot does nothing at all', () => {
    const deps = makeDeps({ drawings: [line({ endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: SITE, lastSafe: SITE } } })] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    let ok = true
    act(() => { ok = result.current.revertGpsFollow([{ id: 'd1', endpoint: 'end' }], 'x') })
    expect(ok).toBe(false)
    expect(deps.commit).not.toHaveBeenCalled()
    expect(deps.log).not.toHaveBeenCalled()
  })

  it('«Am Einsatzort lösen» on a followed end cuts the drive off (not a gesture) and says so in ONE row', () => {
    const deps = makeDeps({ drawings: [followed()] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.releaseGpsOnSite([{ id: 'd1', endpoint: 'end', fallback: DEPOT }], (lines) => `${lines.length} Fahrt entfernt`) })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.commit.mock.calls[0][1]).toEqual({ gesture: false })
    expect(deps.drawings[0].coords).toEqual(onSite)
    expect(deps.drawings[0].endAttachment).toBeUndefined()
    expect(deps.emit.mock.calls.map((c) => c[0])).toEqual(['draw.edit', 'draw.detach'])
    expect(deps.emit.mock.calls[1][1]).toMatchObject({ fallback: SITE })
    expect(deps.log).toHaveBeenCalledTimes(1)
    expect(deps.log.mock.calls[0][1]).toBe('1 Fahrt entfernt')
  })

  it('«Am Einsatzort lassen» on a paused end that never traced: the one end moves, no row', () => {
    const deps = makeDeps({ drawings: [line({ endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: SITE, lastSafe: SITE } } })] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.releaseGpsOnSite([{ id: 'd1', endpoint: 'end', fallback: SITE }], () => 'row') })
    expect(deps.drawings[0].coords).toEqual([[7.7, 47.4], SITE])
    expect(deps.log).not.toHaveBeenCalled()
  })

  it('«Hier lösen (Spur behalten)» and a hand DRAGGING the end off: the end lands where it was let go, the drive stays', () => {
    const deps = makeDeps({ drawings: [followed()] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    const DROP: [number, number] = [8.0105, 47.0072]
    act(() => { result.current.setDrawingAttachment('d1', 'end', undefined, DROP) })
    expect(deps.drawings[0].coords).toEqual([...followed().coords.slice(0, -1), DROP])
    expect(deps.drawings[0].endAttachment).toBeUndefined()
    expect(deps.emit.mock.calls.map((c) => c[0])).toEqual(['draw.detach'])
    expect(deps.log).not.toHaveBeenCalled()
  })

  it('every other detach still moves only the one end', () => {
    const deps = makeDeps({ drawings: [line({ endAttachment: { target: { kind: 'object', id: 'hyd' }, routing: 'direct' } })] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.setDrawingAttachment('d1', 'end', undefined, [7.81, 47.51]) })
    expect(deps.drawings[0].coords).toEqual([[7.7, 47.4], [7.81, 47.51]])
    expect(deps.emit.mock.calls.map((c) => c[0])).toEqual(['draw.detach'])
  })

  it('«Weiter folgen» on every end of one vehicle is ONE step', () => {
    const deps = makeDeps({ drawings: [followed(), followed({ id: 'd2' })] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.patchDrawingsById([{ id: 'd1', patch: { color: '#000000' } }, { id: 'd2', patch: { color: '#000000' } }]) })
    expect(deps.commit).toHaveBeenCalledTimes(1)
    expect(deps.drawings.map((d) => d.color)).toEqual(['#000000', '#000000'])
  })

  it('all of them are no-ops under the tactical lock', () => {
    const deps = makeDeps({ tacticalLocked: true, drawings: [followed()] })
    const { result } = renderHook((p) => useMapDrawing(p), { initialProps: deps })
    act(() => { result.current.revertGpsFollow([{ id: 'd1', endpoint: 'end' }], 'x') })
    act(() => { result.current.releaseGpsOnSite([{ id: 'd1', endpoint: 'end' }], () => 'x') })
    act(() => { result.current.setDrawingAttachment('d1', 'end', undefined, DEPOT) })
    act(() => { result.current.patchDrawingsById([{ id: 'd1', patch: { color: '#000000' } }]) })
    expect(deps.commit).not.toHaveBeenCalled()
  })
})
