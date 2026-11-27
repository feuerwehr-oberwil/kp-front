// @vitest-environment jsdom
// A freehand Linie on the Plan's ink overlay (usePlanCreate · inkMove): the samples are collected
// and the draft in the hand renders once per animation frame, not once per sample – and the
// committed line still carries every sample, also the ones of a frame that never got painted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler, useEffect, useRef } from 'react'
import type { BoardAnno, PlanDocument } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'

// the plan renderer is pdf.js / tiles, neither of which jsdom has: stubbed down to one A3 page
vi.mock('./PdfViewport', () => ({
  PdfViewport: ({ onPages }: { onPages?: (pages: { page: number; widthPt: number; heightPt: number }[]) => void }) => {
    const told = useRef(false)
    useEffect(() => { if (!told.current) { told.current = true; onPages?.([{ page: 0, widthPt: 1191, heightPt: 842 }]) } })
    return null
  },
}))

import { Whiteboard } from './Whiteboard'

const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }
const tafel: PlanDocument = { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape' }

// animation frames run when the test says so: four samples per frame, as an Apple Pencil gives
let frames: FrameRequestCallback[] = []
const flushFrame = () => act(() => { const q = frames; frames = []; for (const f of q) f(0) })
beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f) => { frames.push(f); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const el = Element.prototype as unknown as Record<string, unknown>
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
  el.hasPointerCapture ??= () => false
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount() {
  const onChange = vi.fn<(next: BoardAnno[]) => void>()
  const n = { commits: 0 }
  const { container } = render(<Profiler id="wb" onRender={() => { n.commits++ }}><Whiteboard
    plans={[tafel]} activeId="tafel" annos={[]} onChange={onChange}
    building={null} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} hist={{}} setHist={() => {}} focus={null}
  /></Profiler>)
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Linie' })) })
  flushFrame()
  const ink = container.querySelector('.wb-ink')!
  const ptr = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', [x, y]: [number, number]) =>
    act(() => { fireEvent[type](ink, { pointerType: 'pen', isPrimary: true, pointerId: 1, clientX: x, clientY: y }) })
  return { container, onChange, n, ptr }
}

/** 40 samples after the press, zigzagging 20 px – far over the thinning tolerance, so the
 *  committed line keeps every one of them */
const SAMPLES: [number, number][] = Array.from({ length: 41 }, (_, i) => [20 + i * 9, 200 + (i % 2) * 20])
const committed = (onChange: ReturnType<typeof mount>['onChange']) =>
  onChange.mock.lastCall?.[0].find((a) => a.kind === 'draw')?.pts

describe('a freehand Linie on the Plan', () => {
  it('renders the Whiteboard at most once per frame, and commits every sample', () => {
    const { onChange, n, ptr } = mount()
    ptr('pointerDown', SAMPLES[0])
    n.commits = 0
    // the last four samples are still waiting for their frame when the pen lifts
    SAMPLES.slice(1).forEach((p, i) => { ptr('pointerMove', p); if (i % 4 === 3 && i < 36) flushFrame() })
    // 40 samples in 9 frames and a release, plus the magnet once: leaving the start radius ends the start's claim
    expect(n.commits).toBeLessThanOrEqual(11)
    ptr('pointerUp', SAMPLES[40])
    expect(onChange).toHaveBeenCalledTimes(1) // one line, one commit: one undo step
    expect(committed(onChange)?.map(([x, y]) => [Math.round(x * 400 * 1e6) / 1e6, Math.round(y * 400 * 1e6) / 1e6])).toEqual(SAMPLES)
  })

  it('a second finger drops the stroke with its undrawn samples – none rides into the next one', () => {
    const { container, onChange, ptr } = mount()
    const ink = container.querySelector('.wb-ink')!
    ptr('pointerDown', [300, 50])
    for (const p of [[310, 60], [320, 70], [330, 80]] as [number, number][]) ptr('pointerMove', p)
    act(() => { fireEvent.pointerDown(ink, { pointerType: 'touch', isPrimary: false, pointerId: 2, clientX: 200, clientY: 300 }) })
    act(() => { fireEvent.pointerUp(ink, { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 300 }) })
    ptr('pointerUp', [330, 80])
    expect(onChange).not.toHaveBeenCalled()
    // no frame has run since: the three samples are still queued when the next stroke begins
    ptr('pointerDown', SAMPLES[0])
    SAMPLES.slice(1).forEach((p) => { ptr('pointerMove', p) })
    flushFrame()
    ptr('pointerUp', SAMPLES[40])
    expect(committed(onChange)?.map(([x, y]) => [Math.round(x * 400 * 1e6) / 1e6, Math.round(y * 400 * 1e6) / 1e6])).toEqual(SAMPLES)
  })

  it('shows the stroke live: the samples of each frame are on the screen after it', () => {
    const { container, ptr } = mount()
    ptr('pointerDown', SAMPLES[0])
    SAMPLES.slice(1, 9).forEach((p) => { ptr('pointerMove', p) })
    flushFrame()
    const live = [...container.querySelectorAll('polyline')].map((l) => l.getAttribute('points')?.trim().split(/\s+/).length ?? 0)
    expect(Math.max(...live)).toBe(9)
  })
})
