// @vitest-environment jsdom
/**
 * Where the mode's bar stands in the ADMIN, and what its «Zurücksetzen» means there.
 *
 * ⚠️ Both are variants, not the field's behaviour: in the full-screen plan editor the bar sits
 * BELOW the sheet/map split (the field's is `position: fixed` at the foot of the screen), and the
 * pairs are a draft, so resetting throws that draft away instead of deleting every point. The
 * Whiteboard mounts the same instrument without either prop and must stay exactly as it was.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { resetGeorefMode } from '../lib/georefMode'
import type { AlignmentItem } from './planAlignmentApi'

vi.mock('react-map-gl/maplibre', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="map">{children}</div>,
  Source: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Layer: () => null,
  NavigationControl: () => null,
}))
vi.mock('../components/MapAttribution', () => ({ QuietAttributionControl: () => null }))
vi.mock('../components/GeorefMapLayer', () => ({ GeorefCheckOutline: () => null, GeorefMapLoupe: () => <div data-testid="map-loupe" />, GeorefMapMarks: () => null }))
vi.mock('../components/PdfViewport', () => ({ PdfViewport: () => <div data-testid="sheet" /> }))

import AlignmentPairing from './AlignmentPairing'

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); resetGeorefMode(); vi.restoreAllMocks() })

const item: AlignmentItem = {
  id: 7, dataset_id: 'plan:object:modul2', plan_version: 1, page: 0, page_count: 1, floors: [], can_approve: true,
  object_name: 'Testobjekt', object_lng: 7.55, object_lat: 47.51, module: 'modul2', title: 'Modul 2', is_current: true,
  status: 'no_match', edit_version: 3, pairs: [], aspect: 1.414, scale_m_per_u: null, score: null, coverage: null,
  reason: 'low_coverage', created_at: '2026-09-15T09:00:00Z', updated_at: '2026-09-15T09:00:00Z', approved_at: null,
  reference_rings: [], reference_source: 'OSM', reference_at: null,
}

const mount = (onReset = vi.fn()) => {
  const view = render(<AlignmentPairing item={item} pairs={[]} onPairs={vi.fn()} onDone={vi.fn()} onReset={onReset} previewUrl="blob:sheet" />)
  return { ...view, onReset }
}

it('puts the mode bar BELOW the sheet/map split', async () => {
  const { container } = mount()
  const pairing = container.querySelector('.adm-pairing')!
  await waitFor(() => expect(pairing.querySelector('[role=status]')).toBeTruthy())
  const children = [...pairing.children]
  expect(children[0].className).toContain('adm-pairing-panes')
  expect(children[children.length - 1].getAttribute('role')).toBe('status')
})

/** ONE magnifier at a time: the map's is up only while the pointer is really on the map half.
 *  It used to be up for the whole mode, which put it on screen beside the sheet's loupe — two
 *  crosshairs over two places, one of them nobody was pointing at (15.09.2026). */
it('raises the map magnifier only while the pointer is on the map half', async () => {
  const { container, queryByTestId } = mount()
  await waitFor(() => expect(container.querySelector('[role=status]')).toBeTruthy())
  const map = container.querySelector<HTMLElement>('.adm-pairing-map')!
  expect(queryByTestId('map-loupe')).toBeNull() // the sheet has the turn — its loupe is the one up
  fireEvent.pointerMove(map, { pointerType: 'mouse', clientX: 600, clientY: 200 })
  expect(queryByTestId('map-loupe')).toBeTruthy()
  // ⚠️ `pointerOut`, not `pointerLeave` — React synthesizes the leave from the out event
  fireEvent.pointerOut(map, { pointerType: 'mouse' })
  expect(queryByTestId('map-loupe')).toBeNull()
})

it('makes the bar\'s «Zurücksetzen» discard the draft instead of deleting the stored points', async () => {
  const { container, onReset } = mount()
  const bar = await waitFor(() => container.querySelector<HTMLElement>('[role=status]')!)
  fireEvent.click(within(bar).getByRole('button', { name: appConfig.copy.whiteboard.georef.clearPoints }))
  expect(onReset).toHaveBeenCalledTimes(1)
})
