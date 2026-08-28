// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { MapContentTwin } from '../lib/georefTwins'
import type { BoardAnno } from '../types'

vi.mock('react-map-gl/maplibre', () => ({
  Source: ({ children }: { children: ReactNode }) => <div data-testid="source">{children}</div>,
  Layer: () => <i data-testid="layer" />,
  Marker: ({ children }: { children: ReactNode }) => <div data-testid="marker">{children}</div>,
}))

import { GeorefContentMap } from './GeorefContentMap'

afterEach(cleanup)

const fit = {
  rotationDeg: 0,
  scaleMPerU: 100,
  toMap: ({ x, y }: { x: number; y: number }) => ({ lng: 7.5 + x * 0.001, lat: 47.5 - y * 0.001 }),
} as MapContentTwin['fit']
const point = (anno: BoardAnno): MapContentTwin => ({
  key: anno.id, planId: 'm1', planCode: 'M1', annoId: anno.id, anno, fit, coord: [7.5005, 47.4995],
})

describe('broader Plan content on the Karte', () => {
  it('renders geometry, notes, shapes and Atemschutz markers as inert projections', () => {
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

  it('a mirrored Trupp chip answers a tap with the jump to its source chip', () => {
    const onOpenResource = vi.fn()
    const twins = [point({ id: 'team', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1' })]
    render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive onOpenResource={onOpenResource} />)
    const chip = screen.getByRole('button', { name: /Trupp 1/ })
    fireEvent.pointerDown(chip, { pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(onOpenResource).toHaveBeenCalledWith(expect.objectContaining({ annoId: 'team' }))
  })

  it('…and a mouse press-drag moves the source chip instead of panning the map', () => {
    const onMoveResource = vi.fn()
    const twins = [point({ id: 'team', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1' })]
    // 1000 px per degree, so +50 px of pointer travel is +0.05° of longitude
    const project = (c: [number, number]) => ({ x: (c[0] - 7.5) * 1000, y: (c[1] - 47.5) * 1000 })
    const unproject = (p: { x: number; y: number }) => [7.5 + p.x / 1000, 47.5 + p.y / 1000] as [number, number]
    render(<GeorefContentMap twins={twins} zoom={18} bearing={0} interactive
      onOpenResource={() => {}} onMoveResource={onMoveResource} project={project} unproject={unproject} setDragPan={() => {}} />)
    const chip = screen.getByRole('button', { name: /Trupp 1/ })
    fireEvent.pointerDown(chip, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 100 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 150, clientY: 100 })
    const [twin, coord, phase] = onMoveResource.mock.calls[onMoveResource.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(twin.annoId).toBe('team')
    expect(coord[0]).toBeCloseTo(point({ id: 'x', kind: 'resource' }).coord![0] + 0.05, 5)
  })
})
