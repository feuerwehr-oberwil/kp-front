// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { MapTwin } from '../lib/georefTwins'
import type { BoardAnno } from '../types'

vi.mock('react-map-gl/maplibre', () => ({
  Marker: ({ children, draggable }: { children: ReactNode; draggable?: boolean }) => (
    <div data-testid="marker" data-draggable={draggable ? 'true' : 'false'}>{children}</div>
  ),
}))

import { GeorefTwinsMap } from './GeorefTwinsMap'

afterEach(cleanup)

const anno: BoardAnno = { id: 'a1', kind: 'symbol', symbol: 'Feuer', x: 0.5, y: 0.5, floor: 0 }
// a 50 m wide sheet — the footprint a plan symbol claims is 0.085 × 50 = 4.25 ground metres
const twin = {
  key: 'modul1:a1', planId: 'modul1', planCode: 'Modul 1', annoId: 'a1',
  coord: [7.6, 47.5], anno, fit: { rotationDeg: 0 }, widthM: 50,
} as MapTwin
const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

describe('a Plan twin on the Karte', () => {
  const show = (selectedKey?: string, zoom = 18) => render(
    <GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={zoom} selectedKey={selectedKey}
      onOpen={() => {}} onMove={() => {}} />,
  )

  it('is tap-only before its detail panel selects it', () => {
    show()
    expect(screen.getByTestId('marker').dataset.draggable).toBe('false')
    expect(screen.getByRole('button').className).not.toContain('grab')
  })

  it('becomes draggable together with its selection halo', () => {
    show('modul1:a1')
    expect(screen.getByTestId('marker').dataset.draggable).toBe('true')
    expect(screen.getByRole('button').querySelector('.sel-halo')).toBeTruthy()
  })

  // E9: a plan symbol is ~8.5 % of its sheet — its projection covers those ground metres, not
  // the native pin band. At Einsatz zoom that is the LOW clamp; way in it grows with the ground.
  it('sizes by the building footprint, smaller than any native symbol at Einsatz zoom', () => {
    show(undefined, 18)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(15) // twin floor < native 28
    cleanup()
    show(undefined, 21)
    expect(parseFloat(screen.getByRole('button').style.width)).toBeGreaterThan(15)
  })
})
