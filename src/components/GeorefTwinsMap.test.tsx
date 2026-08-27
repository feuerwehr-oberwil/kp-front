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
const twin = {
  key: 'modul1:a1', planId: 'modul1', planCode: 'Modul 1', annoId: 'a1',
  coord: [7.6, 47.5], anno, fit: {},
} as MapTwin
const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

describe('a Plan twin on the Karte', () => {
  const show = (selectedKey?: string) => render(
    <GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={18} selectedKey={selectedKey}
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
})
