// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fitSimilarity } from '../lib/georef'
import { boardDrawingTwins, boardEntityTwins } from '../lib/georefTwins'
import type { Drawing, Entity } from '../types'
import { GeorefContentBoard } from './GeorefContentBoard'

afterEach(cleanup)

const fit = fitSimilarity([
  { plan: { x: 0, y: 0 }, lngLat: { lng: 7.5, lat: 47.5 } },
  { plan: { x: 1, y: 0 }, lngLat: { lng: 7.501, lat: 47.5 } },
], 1)!
const base = { layer: 'taktisch' as const, coord: [7.5005, 47.5] as [number, number] }

describe('broader Karte content on a Modul', () => {
  it('renders geometry, notes, shapes, Atemschutz markers and shared positions', () => {
    const entities: Entity[] = [
      { ...base, id: 'note', kind: 'note', label: 'Abschnitt West' },
      { ...base, id: 'shape', kind: 'shape', shape: 'square', sizeM: 20 },
      { ...base, id: 'team', kind: 'team', label: 'Trupp 2' },
      { ...base, id: 'person', kind: 'person', label: 'Muster Max', symbolSvg: '<svg viewBox="0 0 10 10" />', live: true },
    ]
    const drawings: Drawing[] = [{ id: 'line', kind: 'line', coords: [[7.5, 47.5], [7.5008, 47.5]], label: 'Leitung 1' }]
    const { container } = render(<GeorefContentBoard entities={boardEntityTwins(entities, fit)} drawings={boardDrawingTwins(drawings, fit)}
      fit={fit} planAspect={1} sW={800} sH={600} byName={{}} />)
    expect(screen.getByText('Abschnitt West')).toBeTruthy()
    expect(screen.getByText('Trupp 2')).toBeTruthy()
    expect(screen.getByText('Muster Max')).toBeTruthy()
    expect(screen.getByText('Leitung 1')).toBeTruthy()
    expect(container.querySelector('.shape-glyph')).toBeTruthy()
    expect(container.querySelector('polyline')).toBeTruthy()
  })
})
