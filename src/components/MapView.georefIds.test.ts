// @vitest-environment jsdom
// Hunt 24.11.2026, karte F5: hiding the first of two georeferenced sheets crashed the workspace.
// react-maplibre throws «source id changed» when a mounted <Source> gets another id; the stub
// below enforces exactly that rule, so the test needs neither a GPU nor the library internals.
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement, Fragment, forwardRef, useRef, type PropsWithChildren } from 'react'
import type { MapViewBaseProps } from './mapViewProps'

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef<unknown, PropsWithChildren>(function MapStub({ children }, _ref) {
    return createElement(Fragment, null, children)
  }),
  Source: function SourceStub({ id, children }: PropsWithChildren<{ id?: string }>) {
    const first = useRef(id)
    if (first.current !== id) throw new Error('source id changed')
    return createElement(Fragment, null, children)
  },
  Layer: () => null,
  Marker: ({ children }: PropsWithChildren) => createElement(Fragment, null, children),
  useControl: () => null,
  useMap: () => ({}),
}))

window.URL.createObjectURL ??= () => 'blob:synthetic'
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
const { MapView } = await import('./MapView')
afterEach(cleanup)

it('hiding the first of two visible plan sheets leaves the other source as it was', () => {
  const sheet = (id: string): NonNullable<MapViewBaseProps['georefPlanRasters']>[number] => ({
    id, url: 'data:image/png;base64,' + id, opacity: 0.55,
    coordinates: [[7.5, 47.51], [7.51, 47.51], [7.51, 47.5], [7.5, 47.5]],
  })
  const a = sheet('modul2'), b = sheet('modul6')
  const props: MapViewBaseProps = {
    initialCenter: [7.5, 47.5], preparedOverlays: [], entities: [], layers: [], byName: {},
    onMapClick: vi.fn(), onSelect: vi.fn(), isVisible: () => true, onView: vi.fn(),
  }
  const h = render(createElement(MapView, { ...props, georefPlanRasters: [a, b] }))
  expect(() => h.rerender(createElement(MapView, { ...props, georefPlanRasters: [b] }))).not.toThrow()
})
