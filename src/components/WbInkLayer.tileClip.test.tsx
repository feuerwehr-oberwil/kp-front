// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { BoardAnno, BuildingDoc, PlanDocument } from '../types'
import { WbCircleLayer, WbInkLayer } from './WbControls'
import { floorGeometry, TILE_AR } from '../lib/whiteboard'
import { fitSimilarity, type GeorefPair } from '../lib/georef'
import { projectOnto } from '../lib/planProjection'
import type { PlanFit, TacticalObject } from '../lib/tacticalObjects'
import { floorStackPages } from '../lib/reportPdfDirect'

/* The field report of 24.09.2026: on the Gebäude a Leitung drawn on the KARTE, from the building
 * to the TLF 200 m south, projected onto the EG tile and ran on through the white gap and the
 * next storey's drawing, down to where the vehicle stood. A storey tile is a window onto ONE
 * storey: the line is cut at its edge and a «geht weiter» mark stands where it leaves. */

afterEach(cleanup)

// the prod shape: a three-storey stack, 100 m across, tiles at the house band (TILE_AR)
const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const M_LAT = 111320
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const PAIRS: GeorefPair[] = [{ plan: { x: 0, y: 0 }, lngLat: ORIGIN }, { plan: { x: 1, y: 0 }, lngLat: mEast(100) }]
const FLOORS_TTB = [1, 0, -1]
// a tile's fit is said in the tile's own aspect, 1 / tileAR (tacticalObjects · PlanFit.stack)
const STACK: PlanFit = { fit: fitSimilarity(PAIRS, 1 / TILE_AR)!, aspect: 1 / TILE_AR, stack: { floors: FLOORS_TTB } }

const building = STACK.fit.toMap({ x: 0.5, y: 0.4 })
const tlf = { lng: building.lng, lat: building.lat - 200 / M_LAT } // 200 m south
const hose: TacticalObject = {
  id: 'h1',
  drawing: { id: 'h1', kind: 'line', coords: [[building.lng, building.lat], [tlf.lng, tlf.lat]], color: '#2f6fed', width: 5 },
}

// the board: 400 px wide, three bands of 400 × TILE_AR
const sW = 400, N = FLOORS_TTB.length, sH = sW * TILE_AR * N
const geo = floorGeometry(true, FLOORS_TTB, N)
const EG = { y0: (1 / N) * sH, y1: (2 / N) * sH } // the EG is the middle band

const pointsOf = (el: Element) => (el.getAttribute('points') ?? '').trim().split(/\s+/).map((s) => s.split(',').map(Number) as [number, number])

const mount = (annos: BoardAnno[], pick = true) => render(
  <WbInkLayer annos={annos} draft={null} draftFloor={0} color="#000" width={5} dashed={false}
    hiddenTrails={new Set()} mapY={geo.mapY} sW={sW} sH={sH} tileOf={geo.tileOf}
    onPickDraw={pick ? () => {} : undefined} />,
)

describe('a Karte Leitung that leaves its storey tile', () => {
  const projected = projectOnto(hose, STACK)!

  it('projects far past the EG tile — the shape that ran through the next storey', () => {
    expect(projected).toMatchObject({ id: 'h1', kind: 'draw', floor: 0 })
    expect(projected.pts![1][1]).toBeGreaterThan(3) // 200 m south of a 72-m tile
  })

  it('is drawn inside the EG tile only, hit only where it is seen, with ONE «geht weiter» mark', () => {
    const { container } = mount([projected])
    const lines = [...container.querySelectorAll('polyline')].filter((p) => !p.closest('.wb-ink-more'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      for (const [x, y] of pointsOf(line)) {
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(sW)
        expect(y).toBeGreaterThanOrEqual(EG.y0 - 1e-9); expect(y).toBeLessThanOrEqual(EG.y1 + 1e-9)
      }
      // …and the whole group is clipped to the tile, round caps and the hit stroke included
      expect(line.closest('g[clip-path]')).not.toBeNull()
    }
    // the tappable stroke is the visible piece: it ends ON the tile's bottom edge
    const hit = lines.find((l) => l.getAttribute('style')?.includes('pointer-events'))!
    expect(Math.max(...pointsOf(hit).map((p) => p[1]))).toBeCloseTo(EG.y1, 6)
    // the clip is the EG band, exactly
    const rect = container.querySelector(`clipPath rect`)!
    expect(Number(rect.getAttribute('y'))).toBeCloseTo(EG.y0, 6)
    expect(Number(rect.getAttribute('height'))).toBeCloseTo(EG.y1 - EG.y0, 6)

    const marks = container.querySelectorAll('.wb-ink-more')
    expect(marks).toHaveLength(1)
    // in the line's colour (never --red / --amber), never a target
    const chevs = [...marks[0].querySelectorAll('polyline[stroke]')]
    expect(chevs.every((c) => c.getAttribute('stroke') === '#2f6fed')).toBe(true)
    expect((marks[0] as SVGGElement).style.pointerEvents).toBe('none')
    for (const c of chevs) for (const [, y] of pointsOf(c)) expect(y).toBeLessThanOrEqual(EG.y1)
  })

  it('a line wholly on its tile is drawn as it always was, with no mark', () => {
    const inside: BoardAnno = { id: 'l', kind: 'draw', floor: 1, color: '#111111', pts: [[0.2, 0.2], [0.8, 0.7]] }
    const { container } = mount([inside], false)
    const [line] = container.querySelectorAll('polyline')
    expect(pointsOf(line)).toEqual([[0.2 * sW, geo.mapY(1, 0.2) * sH], [0.8 * sW, geo.mapY(1, 0.7) * sH]])
    expect(container.querySelector('.wb-ink-more')).toBeNull()
  })

  it('a line wholly off its tile, or an area, is not drawn and cannot be tapped', () => {
    const off: BoardAnno = { id: 'o', kind: 'draw', floor: 1, pts: [[0.2, 1.5], [0.8, 2.5]] }
    const area: BoardAnno = { id: 'a', kind: 'area', floor: 1, pts: [[0.2, 1.5], [0.8, 1.5], [0.5, 2.5]] }
    const { container } = mount([off, area])
    expect(container.querySelectorAll('polyline, polygon')).toHaveLength(0)
  })

  it('an Absperrkreis is seen through its tile only', () => {
    const ring: BoardAnno = { id: 'c', kind: 'circle', floor: 0, x: 0.5, y: 0.9, radiusN: 0.3 }
    const { container } = render(<WbCircleLayer annos={[ring]} draft={null} sW={sW} sH={sH} mapY={geo.mapY} color="#c00" tileOf={geo.tileOf} />)
    expect(container.querySelector('circle')!.closest('g[clip-path]')).not.toBeNull()
  })
})

describe('the printed Gebäude page cuts the same way', () => {
  const plan: PlanDocument = { id: 'gebaeude', code: 'Gebäude', title: 'Gebäude', subtitle: '', imageUrl: '', orientation: 'portrait', floorStack: true }
  const bldg: BuildingDoc = { ring: [[0, 0], [1, 0], [1, 1], [0, 1]], ringAspect: 1, floors: [1, 0, -1], tileAR: TILE_AR }

  it('keeps the Leitung inside the EG band of its page and marks where it leaves', () => {
    const projected = projectOnto(hose, STACK)!
    const [page] = floorStackPages(plan, bldg, [projected])
    // one storey used → the EG is the page's top band of two
    const band = { y0: 0, y1: 0.5 }
    const blue = page.annos.filter((a) => a.kind === 'draw' && a.color === '#2f6fed')
    expect(blue.length).toBeGreaterThan(1) // the line and its chevrons
    for (const a of blue) {
      for (const [, y] of a.pts as number[][]) {
        expect(y).toBeGreaterThanOrEqual(band.y0 - 1e-9)
        expect(y).toBeLessThanOrEqual(band.y1 + 1e-9)
      }
    }
    // the cut line ends on the band's edge; the two chevrons sit just above it
    const [line, ...chevrons] = blue
    expect(Math.max(...(line.pts as number[][]).map((p) => p[1]))).toBeCloseTo(band.y1, 6)
    expect(chevrons).toHaveLength(2)
  })
})
