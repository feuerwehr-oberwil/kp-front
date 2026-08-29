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

function makeDeps(over: { tool?: string; tacticalLocked?: boolean } = {}) {
  // a live doc the commit stub actually applies to, so a burst's second patch sees the first
  let doc = { entities: [], drawings: [line()] } as unknown as Doc
  const deps = {
    drawings: doc.drawings,
    selectedDrawingId: 'd1' as string | null,
    tacticalLocked: over.tacticalLocked ?? false,
    tool: over.tool ?? 'select',
    setTool: vi.fn(),
    commit: vi.fn((u: (d: Doc) => Doc) => { doc = u(doc); deps.drawings = doc.drawings }),
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
    expect(text).toContain('Stockwerk')
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
    // the record stays truthful — created, then taken back
    expect(deps.log.mock.calls.map((c) => c[1])).toContain('Zeichnung gelöscht')
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
