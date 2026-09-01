// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import type { ReactNode } from 'react'
import type { MapContentTwin } from '../lib/georefTwins'
import type { BoardAnno } from '../types'

type Feat = { properties: Record<string, unknown> }
vi.mock('react-map-gl/maplibre', () => ({
  Source: ({ children, id, data }: { children: ReactNode; id?: string; data?: { features?: Feat[] } }) => (
    <div data-testid="source" data-id={id} data-props={JSON.stringify(data?.features?.map((f) => f.properties) ?? [])}>{children}</div>
  ),
  Layer: ({ id }: { id?: string }) => <i data-testid="layer" data-id={id} />,
  Marker: ({ children }: { children: ReactNode }) => <div data-testid="marker">{children}</div>,
}))

import { GeorefContentMap } from './GeorefContentMap'
import { GEOREF_CONTENT_PICK_LAYERS } from '../lib/mapView'

const layerIds = () => screen.getAllByTestId('layer').map((l) => l.dataset.id)
const inkProps = (container: HTMLElement): Record<string, unknown>[] =>
  JSON.parse(container.querySelector<HTMLElement>('[data-id="s-georef-content"]')?.dataset.props ?? '[]')

afterEach(cleanup)

const fit = {
  rotationDeg: 0,
  scaleMPerU: 100,
  toMap: ({ x, y }: { x: number; y: number }) => ({ lng: 7.5 + x * 0.001, lat: 47.5 - y * 0.001 }),
} as MapContentTwin['fit']
const point = (anno: BoardAnno): MapContentTwin => ({
  key: anno.id, planId: 'm1', planCode: 'M1', annoId: anno.id, anno, fit, coord: [7.5005, 47.4995],
})
// 1000 px per degree, so +50 px of pointer travel is +0.05° of longitude
const project = (c: [number, number]) => ({ x: (c[0] - 7.5) * 1000, y: (c[1] - 47.5) * 1000 })
const unproject = (p: { x: number; y: number }) => [7.5 + p.x / 1000, 47.5 + p.y / 1000] as [number, number]
const mouseDrag = (el: Element, from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to[0], clientY: to[1] })
}

describe('broader Plan content on the Karte', () => {
  it('renders geometry, notes, shapes and Atemschutz markers as quiet projections', () => {
    const twins: MapContentTwin[] = [
      { ...point({ id: 'line', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.8]], label: 'Leitung' }), coords: [[7.5, 47.5], [7.501, 47.499]] },
      point({ id: 'note', kind: 'text', x: 0.5, y: 0.5, text: 'Abschnitt Ost' }),
      point({ id: 'shape', kind: 'shape', x: 0.5, y: 0.5, shape: 'cloud', sizeN: 0.2 }),
      point({ id: 'team', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1' }),
    ]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} />)
    expect(screen.getByText('Leitung')).toBeTruthy()
    expect(screen.getByText('Abschnitt Ost')).toBeTruthy()
    expect(screen.getByText('Trupp 1')).toBeTruthy()
    expect(container.querySelector('.shape-glyph')).toBeTruthy()
    expect(screen.getAllByTestId('source')).toHaveLength(1)
    // a surface that passes no open handler stays fully pointer-inert (locked link session)
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps a mirrored Leitung its FKS voice on the Karte too', () => {
    const twins: MapContentTwin[] = [{
      ...point({
        id: 'ltg', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.1]],
        arrow: true, teilstueck: true, content: 'W', lineNo: 2, floorTag: -1, marker: 'R', showDistance: true,
      }),
      coords: [[7.5, 47.5], [7.501, 47.5]],
    }]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} />)
    expect(container.querySelector('.line-fork')).toBeTruthy()
    expect(screen.getByText('2 · W · -1')).toBeTruthy()        // the end tag
    expect(screen.getAllByText('R').length).toBeGreaterThan(0) // the —R— rhythm
    expect(container.querySelector('.draw-label')?.textContent).toMatch(/m ·/)
    // the arrowhead rides the map's own registered icon in its own symbol source
    expect(screen.getAllByTestId('source').length).toBe(2)
  })

  it('a mirrored shape carries the source geometry: stretched box and Stopp-Balken', () => {
    const twins = [point({ id: 'sq', kind: 'shape', x: 0.5, y: 0.5, shape: 'square', sizeN: 0.2, aspect: 2 })]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} />)
    const box = container.querySelector('.shape-glyph') as HTMLElement
    expect(parseFloat(box.style.height)).toBeCloseTo(parseFloat(box.style.width) * 2, 3)
    const arrow = [point({ id: 'ar', kind: 'shape', x: 0.5, y: 0.5, shape: 'arrow', sizeN: 0.2, stop: true })]
    const { container: c2 } = render(<GeorefContentMap twins={arrow} zoom={18} bearing={0} />)
    // the Stopp-Balken is baked into the glyph: two extra strokes over the arrow body
    expect(c2.querySelectorAll('.shape-svg path').length).toBeGreaterThan(1)
  })

  it('every mirrored object answers a tap with its in-place panel', () => {
    const onOpenTwin = vi.fn()
    const twins: MapContentTwin[] = [
      { ...point({ id: 'line', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.8]] }), coords: [[7.5, 47.5], [7.501, 47.499]] },
      point({ id: 'note', kind: 'text', x: 0.5, y: 0.5, text: 'Abschnitt Ost' }),
      point({ id: 'team', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1' }),
    ]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive onOpenTwin={onOpenTwin} />)
    // the pathless kinds are their own hit target; the line gets a grip at its midpoint
    expect(container.querySelectorAll('button')).toHaveLength(3)
    const note = screen.getByRole('button', { name: /Abschnitt Ost/ })
    fireEvent.pointerDown(note, { pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(note, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(onOpenTwin).toHaveBeenCalledWith(expect.objectContaining({ annoId: 'note' }))
    const grip = screen.getByRole('button', { name: /Linie/ })
    fireEvent.pointerDown(grip, { pointerId: 2, isPrimary: true, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(grip, { pointerId: 2, clientX: 50, clientY: 50 })
    expect(onOpenTwin).toHaveBeenCalledWith(expect.objectContaining({ annoId: 'line' }))
  })

  it('the open panel marks its projection with the selection halo', () => {
    const twins = [point({ id: 'note', kind: 'text', x: 0.5, y: 0.5, text: 'Abschnitt Ost' })]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      selectedKey="note" onOpenTwin={() => {}} />)
    expect(container.querySelector('.sel-halo')).toBeTruthy()
  })

  it('a mouse press-drag on a Trupp chip moves the source chip instead of panning the map', () => {
    const onMoveTwin = vi.fn()
    const twins = [point({ id: 'team', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1' })]
    render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      onOpenTwin={() => {}} onMoveTwin={onMoveTwin} project={project} unproject={unproject} setDragPan={() => {}} />)
    mouseDrag(screen.getByRole('button', { name: /Trupp 1/ }), [100, 100], [150, 100])
    const [twin, coord, phase] = onMoveTwin.mock.calls[onMoveTwin.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(twin.annoId).toBe('team')
    expect(coord[0]).toBeCloseTo(point({ id: 'x', kind: 'resource' }).coord![0] + 0.05, 5)
  })

  it('…and a grip drag moves ANY unanchored line whole — only an attached endpoint blocks it', () => {
    // round 8 (full 1:1): the old isLeitung tap-only guard fell — a numbered Leitung drags like
    // any line. Only a line whose endpoint is ANCHORED keeps its whole-drag off (translating
    // stored pts would fork against the plan's re-resolution; its grips reshape it instead).
    const onMoveTwin = vi.fn()
    const twins: MapContentTwin[] = [
      { ...point({ id: 'ltg', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.1]], lineNo: 1 }), coords: [[7.5, 47.5], [7.501, 47.5]] },
      {
        ...point({
          id: 'anchored', kind: 'draw', pts: [[0.1, 0.3], [0.8, 0.3]],
          startAttachment: { target: { kind: 'object', id: 'hydrant' }, routing: 'direct' },
        }),
        coords: [[7.5, 47.49], [7.501, 47.49]],
      },
    ]
    render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      onOpenTwin={() => {}} onMoveTwin={onMoveTwin} project={project} unproject={unproject} setDragPan={() => {}} />)
    const grips = screen.getAllByRole('button')
    mouseDrag(grips[0], [100, 100], [150, 100])
    expect(onMoveTwin.mock.calls.some(([t, , ph]) => t.annoId === 'ltg' && ph === 'end')).toBe(true)
    onMoveTwin.mockClear()
    mouseDrag(grips[1], [100, 100], [150, 100])
    expect(onMoveTwin).not.toHaveBeenCalled()
  })

  it('the selected mirrored line wears the map\'s native vertex vocabulary', () => {
    const onEditTwinAnno = vi.fn()
    const twins: MapContentTwin[] = [
      { ...point({ id: 'plain', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.1]] }), coords: [[7.5, 47.5], [7.501, 47.5]] },
    ]
    render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive selectedKey={twins[0].key}
      onOpenTwin={() => {}} onEditTwinAnno={onEditTwinAnno} project={project} unproject={unproject} setDragPan={() => {}} />)
    // node pads + «+» midpoint + Verlängern at both ends — the native chrome
    expect(document.querySelectorAll('.draw-handle')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: appConfig.copy.measure.insertPoint })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: appConfig.copy.measure.extendLine })).toHaveLength(2)
    // a tap on the «+» inserts the node at the segment midpoint, committed to the one source
    fireEvent.pointerDown(screen.getByRole('button', { name: appConfig.copy.measure.insertPoint }), { pointerId: 5, clientX: 10, clientY: 10 })
    const [, patch, phase] = onEditTwinAnno.mock.calls[0]
    expect(phase).toBe('commit')
    expect(patch.pts).toHaveLength(3)
    expect(patch.pts[1][0]).toBeCloseTo(0.45, 6)
  })

  // ⚠️ D-04 (01.09.): the mirrored ink used to live in a Source PER twin, with generated layer
  // ids that MapView's `interactiveLayerIds` could never name — so a 40 m mirrored Leitung was
  // pointer-dead everywhere except its midpoint dot. One collection with fixed ids gives the
  // projections the native's own 18 px hit band and its selection halo.
  it('carries the map’s own registered ink layers, hit band included', () => {
    const twins: MapContentTwin[] = [
      { ...point({ id: 'line', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.8]] }), coords: [[7.5, 47.5], [7.501, 47.499]] },
      { ...point({ id: 'flaeche', kind: 'area', pts: [[0.1, 0.1], [0.8, 0.1], [0.8, 0.8]] }), coords: [[7.5, 47.5], [7.501, 47.5], [7.501, 47.499]] },
    ]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} />)
    // ONE source for both, not one per object
    expect(container.querySelectorAll('[data-id="s-georef-content"]')).toHaveLength(1)
    for (const id of GEOREF_CONTENT_PICK_LAYERS) expect(layerIds()).toContain(id)
    expect(layerIds()).toContain('l-georef-content-sel')
  })

  // D-16, safety-relevant: the loudest thing the Lage says about people being overdue has to
  // cross the mirror — the end tag's tone alone did not.
  it('gives a mirrored Leitung of an überfällig Trupp the Atemschutz alarm halo', () => {
    const twins: MapContentTwin[] = [
      { ...point({ id: 'ltg', kind: 'draw', pts: [[0.1, 0.1], [0.8, 0.1]], lineNo: 1 }), coords: [[7.5, 47.5], [7.501, 47.5]] },
      { ...point({ id: 'plain', kind: 'draw', pts: [[0.1, 0.3], [0.8, 0.3]] }), coords: [[7.5, 47.49], [7.501, 47.49]] },
    ]
    const trupps = [{ id: 't1', name: 'Meier Anna', lineNo: 1, status: 'in' }] as never
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0}
      trupps={trupps} truppSeverities={{ t1: 2 }} />)
    expect(layerIds()).toContain('l-georef-content-atemschutz')
    expect(inkProps(container).map((f) => f.truppTone)).toEqual(['crit', ''])
  })

  // D-07: the lock is a property of the OBJECT, so it has to hold through the mirror too —
  // otherwise a deliberately locked Sektor-Fläche is still draggable from the other surface.
  it('a locked source goes click-through here as well, with the LockChip as the only way back', () => {
    const onUnlockTwin = vi.fn()
    const twins: MapContentTwin[] = [
      { ...point({ id: 'sektor', kind: 'area', pts: [[0.1, 0.1], [0.8, 0.1], [0.8, 0.8]], locked: true }), coords: [[7.5, 47.5], [7.501, 47.5], [7.501, 47.499]] },
    ]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      selectedKey={twins[0].key} onOpenTwin={() => {}} onEditTwinAnno={() => {}} onUnlockTwin={onUnlockTwin}
      project={project} unproject={unproject} setDragPan={() => {}} />)
    // no grip and no vertex handles, even though it is the SELECTED twin — the LockChip is the
    // only button the object has left
    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].className).toContain('draw-lock-chip')
    expect(document.querySelectorAll('.draw-handle')).toHaveLength(0)
    // the ink itself says so, so MapView skips it when resolving a click
    expect(inkProps(container)[0].locked).toBe(true)
  })

  it('a locked mirrored Form takes no tap and no drag', () => {
    const twins = [point({ id: 'sq', kind: 'shape', x: 0.5, y: 0.5, shape: 'square', sizeN: 0.2, locked: true })]
    const { container } = render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      onOpenTwin={() => {}} onUnlockTwin={() => {}} project={project} unproject={unproject} setDragPan={() => {}} />)
    expect(container.querySelector('.shape-glyph')).toBeTruthy()
    // the LockChip is the ONLY button left
    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].className).toContain('draw-lock-chip')
  })
})
