// @vitest-environment jsdom
// The Plan's annotations are memo'd (PlanAnno · memo, Whiteboard · annoBoard): a one-finger pan
// renders the board per move but no annotation, on the Tafel and the Gebäude – and an annotation
// still renders when its own data, its selection, the zoom or its storey changes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler, useEffect, useRef } from 'react'
import type { BoardAnno, BuildingDoc, PlanDocument } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import { appConfig } from '../config/appConfig'
import { __setUnHazardData, type UnHazardEntry } from '../lib/unHazard'

/** PlanAnno renders: it asks noteScale once per render, and nothing else asks it during a pan */
const counts = vi.hoisted(() => ({ anno: 0 }))
vi.mock('../lib/notes', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/notes')>()
  return { ...mod, noteScale: (...args: Parameters<typeof mod.noteScale>) => { counts.anno++; return mod.noteScale(...args) } }
})
// the ADR table is set by the test (__setUnHazardData), never fetched
vi.mock('../lib/unHazard', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/unHazard')>()), ensureUnHazard: () => Promise.resolve() }))
vi.mock('./PdfViewport', () => ({
  PdfViewport: ({ onPages }: { onPages?: (pages: { page: number; widthPt: number; heightPt: number }[]) => void }) => {
    const told = useRef(false)
    useEffect(() => { if (!told.current) { told.current = true; onPages?.([{ page: 0, widthPt: 1191, heightPt: 842 }]) } })
    return null
  },
}))

import { Whiteboard } from './Whiteboard'

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
  // a real canvas size, so the board has a geometry (jsdom lays out nothing)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 })
})
afterEach(() => { cleanup(); counts.anno = 0 })

const sym: SymbolsApi = { ready: false, error: false, reload: () => {}, order: [], symbols: [], byName: {} }
const tafel: PlanDocument = { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape' }
const gebaeude: PlanDocument = { id: 'gebaeude', code: 'Gebäude', title: 'Gebäude', subtitle: '', imageUrl: '', orientation: 'portrait', icon: 'floors', floorStack: true }
const building: BuildingDoc = { ring: [[0, 0], [1, 0], [1, 1], [0, 1]], ringAspect: 1, floors: [0, 1, 2] }
/** 40 notes over 3 storeys, and a symbol that spans all three (one instance per storey on the
 *  Gebäude – lib/stackFloors · stackInstances) */
const annos: BoardAnno[] = [
  ...Array.from({ length: 40 }, (_, i): BoardAnno => ({ id: `n${i}`, kind: 'text', x: 0.1 + (i % 8) * 0.1, y: 0.2 + Math.floor(i / 8) * 0.12, floor: i % 3, text: `Notiz ${i}` })),
  { id: 's1', kind: 'symbol', symbol: 'Treppe', x: 0.5, y: 0.9, floor: 0, floorFrom: 0, floorTo: 2 },
]

/** Mounts a board and counts from there: Whiteboard commits (Profiler) and PlanAnno renders. */
const mount = (activeId: string, list0: BoardAnno[] = annos) => {
  const n = { commits: 0 }
  const board = (list: BoardAnno[]) => <Profiler id="wb" onRender={() => { n.commits++ }}><Whiteboard
    plans={[tafel, gebaeude]} activeId={activeId} annos={list} onChange={() => {}}
    building={building} onSelectBuilding={() => {}} onAddFloor={() => {}} onRemoveFloor={() => {}}
    sym={sym} onRecent={() => {}} log={() => {}} hist={{}} setHist={() => {}} focus={null}
  /></Profiler>
  const utils = render(board(list0))
  const canvas = utils.container.querySelector('.wb-canvas')!
  const annoEls = () => [...utils.container.querySelectorAll<HTMLElement>('.wb-anno')]
  const annoCount = annoEls().length
  n.commits = 0; counts.anno = 0
  return { ...utils, canvas, annoEls, annoCount, n, rerenderWith: (list: BoardAnno[]) => utils.rerender(board(list)) }
}
const touch = (canvas: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number, clientY: number) =>
  act(() => { fireEvent[type](canvas, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX, clientY }) })
const noteEl = (b: ReturnType<typeof mount>, text: string) => b.annoEls().find((el) => el.textContent === text)!

describe('a one-finger pan on the Plan', () => {
  it.each(['tafel', 'gebaeude'])('renders no annotation on the %s', (id) => {
    const b = mount(id)
    expect(b.annoCount).toBe(id === 'tafel' ? 41 : 43)
    const before = b.annoEls().map((el) => el.style.transform)
    touch(b.canvas, 'pointerDown', 500, 350)
    for (let i = 1; i <= 30; i++) touch(b.canvas, 'pointerMove', 500 + i * 4, 350 + i * 2)
    touch(b.canvas, 'pointerUp', 620, 410)
    expect(b.n.commits).toBeGreaterThanOrEqual(30) // the board still follows per move
    expect(counts.anno).toBe(0)
    // the annotations sit on the board, which moved: their own placement is unchanged
    expect(b.annoEls().map((el) => el.style.transform)).toEqual(before)
  })
})

describe('an annotation still renders when what it shows changes', () => {
  it('its own data', () => {
    const b = mount('tafel')
    b.rerenderWith(annos.map((a) => (a.id === 'n3' ? { ...a, text: 'Geändert' } : a)))
    expect(noteEl(b, 'Geändert')).toBeTruthy()
  })

  it('its selection, also after the board re-rendered with new closures', () => {
    const b = mount('tafel')
    b.rerenderWith([...annos])
    const el = noteEl(b, 'Notiz 5')
    act(() => { fireEvent.pointerDown(el, { pointerType: 'mouse', isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 100 }) })
    expect(noteEl(b, 'Notiz 5').className).toContain('sel')
    expect(noteEl(b, 'Notiz 6').className).not.toContain('sel')
  })

  it('the zoom', () => {
    const b = mount('tafel')
    const before = noteEl(b, 'Notiz 9').style.transform
    act(() => { fireEvent.click(screen.getAllByRole('button', { name: appConfig.copy.nav.zoomIn })[0]) })
    expect(counts.anno).toBeGreaterThan(0)
    expect(noteEl(b, 'Notiz 9').style.transform).not.toBe(before)
  })

  it('its storey on the Gebäude', () => {
    const b = mount('gebaeude')
    const before = noteEl(b, 'Notiz 0').style.transform
    b.rerenderWith(annos.map((a) => (a.id === 'n0' ? { ...a, floor: 2 } : a)))
    expect(noteEl(b, 'Notiz 0').style.transform).not.toBe(before)
  })

  it('the ADR table landing – a Gefahrentafel shows its Kemler number', () => {
    const plate: BoardAnno = { id: 'g1', kind: 'symbol', symbol: appConfig.symbols.placardName, x: 0.5, y: 0.5, floor: 0, fields: { [appConfig.copy.contextPanel.unField]: '1203' } }
    const b = mount('tafel', [plate])
    const el = () => b.annoEls().find((x) => x.innerHTML.includes('>1203<'))!
    expect(el().innerHTML).not.toContain('>33<')
    act(() => { __setUnHazardData([{ un: '1203', name_de: 'Benzin', name_en: 'Gasoline', class: '3', classificationCode: 'F1', packingGroup: 'II', hazardLabels: ['3'], hazardNumber: '33' } as UnHazardEntry]) })
    expect(el().innerHTML).toContain('>33<')
  })
})
