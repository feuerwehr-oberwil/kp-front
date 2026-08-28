// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
})
