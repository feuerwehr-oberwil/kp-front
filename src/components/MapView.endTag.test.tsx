// @vitest-environment jsdom
/**
 * A Leitung's end tag on the Karte, through the real MapView (`<Map>` and `<Marker>` are
 * stand-ins, as in MapView.northSnap.test): a line that carries only a plain Person (16.11.2026,
 * types · Drawing.person) still gets its tag – the guard used to ask for a number, a Typ or a
 * Geschoss, so a person-only Leitung showed nobody (CodeRabbit on #646).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { forwardRef, type ReactNode } from 'react'
import { vi } from 'vitest'
import type { Drawing } from '../types'

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef<unknown, { children?: ReactNode }>(function MapStandIn(props, _ref) {
    return <div data-testid="map">{props.children}</div>
  }),
  Marker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Source: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Layer: () => null,
  useControl: () => null,
  useMap: () => ({ current: undefined }),
}))

// maplibre-gl mints its worker URL from a Blob at import time; jsdom has no createObjectURL
window.URL.createObjectURL ??= () => 'blob:test'
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const { MapView } = await import('./MapView')
const noop = () => {}

function mount(drawings: Drawing[]) {
  return render(
    <MapView
      entities={[]} layers={[]} byName={{}} initialCenter={[7.555, 47.515]} preparedOverlays={[]}
      isVisible={() => true} selectedId={null} onSelect={noop} onMapClick={noop}
      drawings={drawings} drawingsVisible draft={[]} draftKind={null} draggable={false}
      onMarkerDragStart={noop} onMarkerMove={noop} onMarkerDragEnd={noop} onView={noop}
      freehand={null} onFreehand={noop} drawColor="#000" drawWidth={3} drawDashed={false}
      selectedDrawingId={null} onSelectDrawing={noop} onDelete={noop}
    />,
  )
}

const line = (over: Partial<Drawing>): Drawing => ({ id: 'd1', kind: 'line', coords: [[7.555, 47.515], [7.556, 47.516]], ...over })

afterEach(cleanup)

describe('the Karte end tag', () => {
  it('a line with only a Person on it shows the person, abbreviated', () => {
    const { container } = mount([line({ person: 'Frei Nico' })])
    expect(container.querySelector('.line-end-tag')?.textContent).toBe('Frei N.')
  })

  it('a plain line draws no tag at all', () => {
    const { container } = mount([line({})])
    expect(container.querySelector('.line-end-tag')).toBeNull()
  })
})
