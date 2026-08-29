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

  it('is immediately draggable before its detail panel selects it', () => {
    show()
    expect(screen.getByTestId('marker').dataset.draggable).toBe('true')
    expect(screen.getByRole('button').className).toContain('grab')
  })

  it('becomes draggable together with its selection halo', () => {
    show('modul1:a1')
    expect(screen.getByTestId('marker').dataset.draggable).toBe('true')
    expect(screen.getByRole('button').querySelector('.sel-halo')).toBeTruthy()
  })

  // E9 + the 29.08 field correction: the footprint may quiet a twin below the native floor,
  // but it may never grow past the native map's SMALLEST symbol size. Otherwise the same Feuer
  // and its fixed-size caption/count badges balloon on a linked Modul while the Lage copy stays
  // in its compact map band.
  it('sizes by the building footprint but caps at the native 28 px floor', () => {
    show(undefined, 18)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(15) // twin floor < native 28
    cleanup()
    show(undefined, 21)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(28)
  })
})
