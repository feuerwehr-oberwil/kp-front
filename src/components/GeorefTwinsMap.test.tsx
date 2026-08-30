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
  coord: [7.6, 47.5], anno, fit: { rotationDeg: 0 },
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

  // 30.08. doctrine (supersedes E9's quieter footprint band): a twin renders EXACTLY like a
  // native symbol standing beside it — same symPx band, so an F and its mirror are visually
  // one object. At z18 the band floor holds, at z21 a symbol's 8 m reach its 48 px ceiling.
  it('sizes like a native map symbol (symPx band), not a quieter twin band', () => {
    show(undefined, 18)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(28) // the native floor
    cleanup()
    show(undefined, 21)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(48) // the native ceiling
  })
})
