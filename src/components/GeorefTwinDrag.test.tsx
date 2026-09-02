// @vitest-environment jsdom
/**
 * Dragging a mirrored Karte object on a georeferenced sheet moves the SOURCE object.
 *
 * Until 27.08. it did not: TwinMark swallowed pointerdown and answered taps only, while
 * `startEntityMove`'s doc had long claimed the projection as one of its two call sites. What
 * follows pins the two halves the gesture is actually made of — the board turning a pixel delta
 * into a point on the sheet, and the fit folding that point back into a ground coordinate.
 * (TwinMark's own tap-vs-drag rule lives in GeorefTwinMark.test.tsx.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BoardAnno, Entity } from '../types'
import { GeorefTwinsBoard } from './GeorefTwinsBoard'
import { fitSimilarity } from '../lib/georef'
import { clampToSheet, sheetShift, SHEET_DOMAIN, twinBoundOf, type SheetEdge } from '../lib/georefTwins'
import type { BoardTwin, MapTwin } from '../lib/georefTwins'

// the map half of the mirror only needs the Marker to place its child somewhere
vi.mock('react-map-gl/maplibre', () => ({
  Marker: ({ children }: { children: ReactNode }) => <div data-testid="marker">{children}</div>,
}))
import { GeorefTwinsMap } from './GeorefTwinsMap'

afterEach(cleanup)

const tlf = { id: 'e1', kind: 'symbol', layer: 'lage', coord: [8.0005, 47.0005], label: 'TLF Oberwil' } as Entity
const TWIN_FIT = fitSimilarity([
  { plan: { x: 0, y: 0 }, lngLat: { lng: 8, lat: 47 } },
  { plan: { x: 1, y: 0 }, lngLat: { lng: 8.001, lat: 47 } },
], 1)!
const twinAt = (x: number, y: number): BoardTwin => ({ key: 'modul2:e1', kind: 'symbol', entityId: 'e1', pt: { x, y }, entity: tlf, fit: TWIN_FIT })

const SW = 1000, SH = 500
const renderBoard = (onMove?: typeof vi.fn extends never ? never : ((t: BoardTwin, p: { x: number; y: number }, ph: 'start' | 'move' | 'end') => void)) =>
  render(<GeorefTwinsBoard twins={[twinAt(0.5, 0.5)]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
    selectedKey="modul2:e1" onOpen={() => {}} onMove={onMove} />)

const mark = () => screen.getByRole('button')
const drag = (to: [number, number]) => {
  const m = mark()
  fireEvent.pointerDown(m, { pointerId: 1, clientX: 200, clientY: 200 })
  fireEvent.pointerMove(m, { pointerId: 1, clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(m, { pointerId: 1, clientX: to[0], clientY: to[1] })
}

describe('a twin dragged across the sheet', () => {
  it('turns the pixel travel into a point in the SHEET’s own space', () => {
    const onMove = vi.fn()
    renderBoard(onMove)
    // +100px across a 1000px sheet = +0.1; +50px down a 500px sheet = +0.1
    drag([300, 250])
    const [twin, pt, phase] = onMove.mock.calls[onMove.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(twin.entityId).toBe('e1')          // the source on the Karte, never the projection
    expect(pt.x).toBeCloseTo(0.6, 6)
    expect(pt.y).toBeCloseTo(0.6, 6)
  })

  // a point off the paper is not a place on that document, and would fold back through the fit
  // as a ground coordinate nobody aimed at
  /**
   * ⚠️ THE regression test for «bewegt sich viel zu weit» (27.08.).
   *
   * The board is re-rendered mid-drag with the projection already moved — that is the whole point
   * of a twin following its source. So the cumulative delta from the mark has to be added to where
   * the twin STOOD when the finger went down, not to its live position. Adding it to the live prop
   * re-applied the whole travel on every sample: 25 → 75 → 150 → 250 px for four samples of 25.
   *
   * The earlier test missed this by holding `pt` fixed for the whole gesture, which is the one
   * thing the real board never does.
   */
  it('follows the finger 1:1 even though the twin moves under it', () => {
    let pt = { x: 0.2, y: 0.2 }
    const seen: { x: number; y: number }[] = []
    const Live = () => {
      const [p, setP] = useState(pt)
      return <GeorefTwinsBoard twins={[{ ...twinAt(p.x, p.y) }]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
        selectedKey="modul2:e1" onOpen={() => {}} onMove={(_t, next) => { seen.push(next); pt = next; setP(next) }} />
    }
    render(<Live />)
    const m = screen.getByRole('button')
    fireEvent.pointerDown(m, { pointerId: 1, clientX: 100, clientY: 100 })
    for (const step of [25, 50, 75, 100]) {
      fireEvent.pointerMove(m, { pointerId: 1, clientX: 100 + step, clientY: 100 })
    }
    fireEvent.pointerUp(m, { pointerId: 1, clientX: 200, clientY: 100 })
    // 100px of travel across a 1000px sheet = exactly +0.1, however many samples it took
    expect(pt.x).toBeCloseTo(0.3, 9)
    expect(pt.y).toBeCloseTo(0.2, 9)
    // …and it never overshot on the way, which is what «viel zu weit» looked like
    for (const s of seen) expect(s.x).toBeLessThanOrEqual(0.3 + 1e-9)
  })

  it('clamps to the sheet rather than naming a point off the paper', () => {
    const onMove = vi.fn()
    renderBoard(onMove)
    drag([5000, 5000])
    const [, pt] = onMove.mock.calls[onMove.mock.calls.length - 1]
    expect(pt).toEqual({ x: 1, y: 1 })
  })

  /**
   * The board side of the same constraint, and why it needs no chrome: here the bound IS the
   * sheet the operator is looking at. What it does need is to behave — the point is taken from
   * the SNAPSHOT plus the pointer's total travel, so it slides along the edge without jumping,
   * without oscillating, and comes back the moment the finger does.
   */
  it('slides along the sheet edge and comes straight back, with no jump on the way', () => {
    const onMove = vi.fn()
    renderBoard(onMove)
    const m = mark()
    fireEvent.pointerDown(m, { pointerId: 1, clientX: 200, clientY: 200 })
    const at = (i: number) => onMove.mock.calls[i]?.[1] as { x: number; y: number }
    // far past the right edge, then down along it, then back onto the paper
    fireEvent.pointerMove(m, { pointerId: 1, clientX: 2000, clientY: 200 })
    expect(at(onMove.mock.calls.length - 1)).toEqual({ x: 1, y: 0.5 })
    fireEvent.pointerMove(m, { pointerId: 1, clientX: 2000, clientY: 300 })
    expect(at(onMove.mock.calls.length - 1)).toEqual({ x: 1, y: 0.7 })   // free axis still live
    fireEvent.pointerMove(m, { pointerId: 1, clientX: 300, clientY: 300 })
    fireEvent.pointerUp(m, { pointerId: 1, clientX: 300, clientY: 300 })
    // …and back where the finger actually is: +100px of 1000 across, +100px of 500 down
    const last = onMove.mock.calls[onMove.mock.calls.length - 1][1]
    expect(last.x).toBeCloseTo(0.6, 9)
    expect(last.y).toBeCloseTo(0.7, 9)
  })

  it('offers no drag at all when the surface does not pass one (locked / viewer)', () => {
    renderBoard(undefined)
    expect(mark().className).not.toContain('grab')
  })

  it('moves immediately without requiring a selection tap first', () => {
    const onOpen = vi.fn()
    const onMove = vi.fn()
    render(<GeorefTwinsBoard twins={[twinAt(0.5, 0.5)]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
      onOpen={onOpen} onMove={onMove} />)
    expect(mark().className).toContain('grab')
    drag([300, 250])
    expect(onMove).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps automatic floor and count badges upright on a differently oriented Modul', () => {
    const directional = {
      ...tlf,
      symbol: 'VKF Luefter mobil', rotation: 35, floor: 1, count: 2,
    } as Entity
    const turned = { ...twinAt(0.5, 0.5), entity: directional, fit: { ...TWIN_FIT, rotationDeg: 40 } }
    render(<GeorefTwinsBoard twins={[turned]} byName={{ 'VKF Luefter mobil': '<svg viewBox="0 0 10 10" />' }}
      sW={SW} sH={SH} sizePx={28} planWidthM={100} onOpen={() => {}} />)
    const glyph = document.querySelector<HTMLElement>('.ts-rot')!
    expect(glyph.style.transform).toContain('rotate(75deg)')
    for (const badge of document.querySelectorAll('.sym-floor, .sym-count')) {
      expect(badge.closest('.ts-rot')).toBeNull()
      expect((badge as HTMLElement).style.transform).toBe('')
    }
  })
})

describe('the fold back through the fit', () => {
  // three pairs, axis-aligned: 1 sheet unit across = 0.001° lng, and the sheet's y grows
  // DOWNWARD while latitude grows upward — the flip the fit has to get right
  const fit = fitSimilarity([
    { plan: { x: 0, y: 0 }, lngLat: { lng: 8.0, lat: 47.001 }, kind: 'gesetzt' },
    { plan: { x: 1, y: 0 }, lngLat: { lng: 8.001, lat: 47.001 }, kind: 'gesetzt' },
    { plan: { x: 0, y: 1 }, lngLat: { lng: 8.0, lat: 47.0 }, kind: 'gesetzt' },
  ], 1)

  it('sends a drag to the right eastward, and a drag downward southward', () => {
    expect(fit).toBeTruthy()
    const from = fit!.toMap({ x: 0.5, y: 0.5 })
    expect(fit!.toMap({ x: 0.6, y: 0.5 }).lng).toBeGreaterThan(from.lng)
    expect(fit!.toMap({ x: 0.5, y: 0.6 }).lat).toBeLessThan(from.lat)
  })

  // the mark must land where it was dropped: toPlan/toMap are exact inverses, so what the
  // residual costs is how well the SHEET matches the ground — not where the symbol appears
  it('round-trips a plan point through the map and back', () => {
    const pt = { x: 0.37, y: 0.62 }
    const back = fit!.toPlan(fit!.toMap(pt))
    expect(back.x).toBeCloseTo(pt.x, 9)
    expect(back.y).toBeCloseTo(pt.y, 9)
  })
})

/**
 * ⚠️ THE AXIS regression (02.09.) — «ein gespiegeltes Feuer lässt sich nur auf einer Achse
 * ziehen».
 *
 * Every drag test above pulls along ONE axis on a square, north-up sheet, which is the one shape
 * of sheet where an aspect or a y-flip mistake cannot show. A mirrored symbol on a real Modul
 * lives on a sheet that is neither: plan x and y are fractions of DIFFERENT edges, so the fit
 * runs in `(x·ar, y)` with y flipped, and getting either wrong collapses the inverse towards a
 * line — the drag then follows the finger's PROJECTION onto one plan axis instead of the finger.
 * So: a diagonal drag, through a fit that is turned 30° and 1.6 : 1, and both coordinates
 * checked against amounts derived from the transform rather than from the fit's own inverse.
 */
const DEG = Math.PI / 180
const R_EARTH = 6378137
const LAT0 = 47.5
const K = Math.cos(LAT0 * DEG) * R_EARTH
const M0 = { x: K * 7.6 * DEG, y: K * Math.log(Math.tan(Math.PI / 4 + LAT0 * DEG / 2)) }
/** the georef module's own latitude-corrected Mercator metres, both ways */
const toLngLat = (mx: number, my: number) => ({ lng: mx / K / DEG, lat: (2 * Math.atan(Math.exp(my / K)) - Math.PI / 2) / DEG })
const toMetre = (lng: number, lat: number) => ({ x: K * lng * DEG, y: K * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)) })

/** a sheet 1.6 : 1, one plan unit of HEIGHT = 80 m of ground, laid down 30° off north */
const AR = 1.6, TURN = 30 * DEG, MPU = 80
const planToLngLat = (x: number, y: number) => toLngLat(
  M0.x + MPU * (Math.cos(TURN) * x * AR - Math.sin(TURN) * -y),
  M0.y + MPU * (Math.sin(TURN) * x * AR + Math.cos(TURN) * -y),
)
const TURNED_FIT = fitSimilarity([
  { plan: { x: 0, y: 0 }, lngLat: planToLngLat(0, 0) },
  { plan: { x: 1, y: 0 }, lngLat: planToLngLat(1, 0) },
  { plan: { x: 0, y: 1 }, lngLat: planToLngLat(0, 1) },
], AR)!
/** the plan-space delta a ground displacement of (east, north) metres HAS to produce */
const planDelta = (east: number, north: number) => ({
  x: (Math.cos(TURN) * east + Math.sin(TURN) * north) / (MPU * AR),
  y: (Math.sin(TURN) * east - Math.cos(TURN) * north) / MPU,
})

describe('a diagonal drag on a turned, non-square sheet', () => {
  const feuer: BoardAnno = { id: 'a1', kind: 'symbol', symbol: 'Feuer', x: 0.4, y: 0.4, floor: 0 }
  const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
  // a plain 4 px per metre map transform, in the same metric space the fit works in
  const PPM = 4
  const project = (c: [number, number]) => { const m = toMetre(c[0], c[1]); return { x: (m.x - M0.x) * PPM, y: -(m.y - M0.y) * PPM } }
  const unproject = (p: { x: number; y: number }) => { const g = toLngLat(M0.x + p.x / PPM, M0.y - p.y / PPM); return [g.lng, g.lat] as [number, number] }

  it('moves a mirrored symbol on the KARTE in both plan coordinates at once', () => {
    let written = { x: feuer.x!, y: feuer.y! }
    const Live = () => {
      const [a, setA] = useState<BoardAnno>(feuer)
      const { lng, lat } = TURNED_FIT.toMap({ x: a.x!, y: a.y! })
      const twin = { key: 'm:a1', planId: 'm', planCode: 'M', annoId: 'a1', coord: [lng, lat], anno: a, fit: TURNED_FIT } as MapTwin
      return <GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={18} selectedKey="m:a1"
        onOpen={() => {}} project={project} unproject={unproject}
        // the surface's own write-through, in the one shape IncidentWorkspace writes it
        // (moveMapTwinSource): fold the ground coordinate back and store BOTH halves
        onMove={(t, coord, phase) => {
          if (phase === 'start') return
          const p = t.fit.toPlan({ lng: coord[0], lat: coord[1] })
          written = { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }
          setA((prev) => ({ ...prev, ...written }))
        }} />
    }
    render(<Live />)
    const mark = screen.getByRole('button')
    fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120, clientY: 130 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 160 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 140, clientY: 160 })
    // +40 px east = +10 m, +60 px DOWN = 15 m south
    const want = planDelta(10, -15)
    expect(want.x).not.toBeCloseTo(0, 3)   // the drag really does ask both axes to move
    expect(want.y).not.toBeCloseTo(0, 3)
    expect(written.x).toBeCloseTo(0.4 + want.x, 5)
    expect(written.y).toBeCloseTo(0.4 + want.y, 5)
  })

  /**
   * ⚠️ THE «nur auf einer Achse» report, in one test (02.09.). It is not a transform bug: the
   * source lives on a BOUNDED sheet, so a diagonal drag that crosses the projected paper edge
   * pins that plan coordinate and goes on following the finger with the other. The object slides
   * along the edge — which is right, and which the Karte now also SHOWS, because a map draws no
   * paper (MapView · twinBound).
   */
  it('slides a mirrored symbol along the sheet edge it met, and names that edge', () => {
    const feuerEdge: BoardAnno = { ...feuer, x: 0.9, y: 0.4 }
    let written = { x: feuerEdge.x!, y: feuerEdge.y! }
    let held: SheetEdge[] = []
    const Live = () => {
      const [a, setA] = useState<BoardAnno>(feuerEdge)
      const { lng, lat } = TURNED_FIT.toMap({ x: a.x!, y: a.y! })
      const twin = { key: 'm:a1', planId: 'm', planCode: 'M', annoId: 'a1', coord: [lng, lat], anno: a, fit: TURNED_FIT } as MapTwin
      return <GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={18} selectedKey="m:a1"
        onOpen={() => {}} project={project} unproject={unproject}
        onMove={(t, coord, phase) => {
          if (phase === 'start') return
          const out = clampToSheet(t.fit.toPlan({ lng: coord[0], lat: coord[1] }))
          written = out.pt; held = out.held
          setA((prev) => ({ ...prev, ...out.pt }))
        }} />
    }
    render(<Live />)
    const mark = screen.getByRole('button')
    // straight along the sheet's own +x axis (30° off east), far past its right-hand edge, while
    // ALSO travelling down the sheet — one diagonal drag, one axis of it impossible
    const step = (n: number): [number, number] => [
      100 + Math.cos(TURN) * n, 100 - Math.sin(TURN) * n + n * 0.4,
    ]
    fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    for (const n of [40, 120, 400]) {
      const [x, y] = step(n)
      fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y })
    }
    const [ex, ey] = step(400)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: ex, clientY: ey })
    expect(written.x).toBe(1)                        // pinned at the paper's right edge…
    expect(written.y).toBeGreaterThan(0.4)           // …while the free axis kept following
    expect(written.y).toBeLessThan(1)
    expect(held).toEqual(['right'])                  // and the surface can light that edge
  })

  /**
   * ⚠️ THE «die Umrandung passt nicht zum Anschlag» regression (02.09.).
   *
   * The outline the Karte draws and the bound a drag actually meets have to be ONE thing. They
   * were not derived from one: the rectangle came from beside the clamp rather than from it, and
   * the bar's own twin move drew the rectangle while enforcing nothing at all, so a mirrored
   * object pulled from ✥ sailed straight through the line that had just promised where it would
   * stop. Both now read `SHEET_DOMAIN` — and this is the assertion that keeps them there: the
   * drawn corners ARE that domain through the drag's own fit, and a clamped landing is ON the
   * drawn edge, to the same numbers.
   */
  it('draws exactly the rectangle it clamps to, and clamps exactly onto what it drew', () => {
    const bound = twinBoundOf(TURNED_FIT, ['right'])
    // 1 — the corners are the clamp domain, through the very fit the write-through inverts
    const projected = SHEET_DOMAIN.map((p) => { const c = TURNED_FIT.toMap(p); return [c.lng, c.lat] })
    expect(bound.ring).toEqual(projected)
    // …and every one of them comes back as a corner of the domain, so nothing was re-derived
    bound.ring.forEach((c, i) => {
      const back = TURNED_FIT.toPlan({ lng: c[0], lat: c[1] })
      expect(back.x).toBeCloseTo(SHEET_DOMAIN[i].x, 9)
      expect(back.y).toBeCloseTo(SHEET_DOMAIN[i].y, 9)
    })
    // 2 — a drag pushed off the right-hand side lands ON the segment that was drawn for it
    const [a, b] = bound.held[0]
    const { pt, held } = clampToSheet(TURNED_FIT.toPlan(TURNED_FIT.toMap({ x: 2.4, y: 0.55 })))
    expect(held).toEqual(['right'])
    const g = TURNED_FIT.toMap(pt)
    // collinear with the drawn edge (cross product of the two spans) and between its ends
    expect(Math.abs((b[0] - a[0]) * (g.lat - a[1]) - (b[1] - a[1]) * (g.lng - a[0]))).toBeLessThan(1e-12)
    // …and at the right place ALONG it. Measured in raw lng/lat, where the segment is straight
    // but its parameterisation is not quite uniform (a degree of latitude is not a degree of
    // longitude): 1e-5 of the edge is ~1 mm on an 80 m sheet.
    const along = ((g.lng - a[0]) * (b[0] - a[0]) + (g.lat - a[1]) * (b[1] - a[1]))
      / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
    expect(along).toBeCloseTo(0.55, 5)
    // 3 — and the bar's own writer measures against the same domain, so it stops there too
    const barShift = sheetShift([{ x: 0.9, y: 0.5 }], { x: 0.4, y: 0 })
    expect(barShift.dx).toBeCloseTo(0.1, 9)
    expect(barShift.held).toEqual(['right'])
  })

  it('…and a mirrored Karte object on the PLAN lands where it was dropped, both ways', () => {
    const tlfHere = { ...tlf, coord: [0, 0] } as Entity
    const start = { x: 0.4, y: 0.4 }
    const onMove = vi.fn()
    render(<GeorefTwinsBoard twins={[{ key: 'p:e1', kind: 'symbol', entityId: 'e1', pt: start, entity: tlfHere, fit: TURNED_FIT }]}
      byName={{}} sW={1000} sH={625} sizePx={40} planWidthM={MPU * AR}
      selectedKey="p:e1" onOpen={() => {}} onMove={onMove} />)
    fireEvent.pointerDown(screen.getByRole('button'), { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(screen.getByRole('button'), { pointerId: 1, clientX: 300, clientY: 325 })
    fireEvent.pointerUp(screen.getByRole('button'), { pointerId: 1, clientX: 300, clientY: 325 })
    const [, pt] = onMove.mock.calls[onMove.mock.calls.length - 1]
    // +100 px of 1000 across, +125 px of 625 down — a share of each of the sheet's OWN edges
    expect(pt.x).toBeCloseTo(0.5, 9)
    expect(pt.y).toBeCloseTo(0.6, 9)
    // …and folded back through the turned fit that is a real ground displacement in both axes
    const from = TURNED_FIT.toMap(start), to = TURNED_FIT.toMap(pt)
    const east = toMetre(to.lng, to.lat).x - toMetre(from.lng, from.lat).x
    const north = toMetre(to.lng, to.lat).y - toMetre(from.lng, from.lat).y
    const back = planDelta(east, north)
    expect(back.x).toBeCloseTo(0.1, 6)
    expect(back.y).toBeCloseTo(0.2, 6)
  })
})
