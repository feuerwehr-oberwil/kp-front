// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GeorefQuality } from './GeorefQuality'
import { fitSimilarity, type GeorefPair } from '../lib/georef'
import { appConfig } from '../config/appConfig'

/* «Passung» on a fit that came out of «Automatisch ausrichten»: a PROPOSAL is unmeasured and
 * says so, an APPROVED one is linked and must not (18.09.2026). Neither ever invents a ⌀. */
const C = appConfig.copy.whiteboard.georef
const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const AUTO: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN, kind: 'auto' },
  { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN.lng + 0.001, lat: ORIGIN.lat }, kind: 'auto' },
]
const FIT = fitSimilarity(AUTO, 1)!

const show = (props: Partial<Parameters<typeof GeorefQuality>[0]> = {}) =>
  render(
    <GeorefQuality
      fit={FIT}
      auto
      onAddPoint={vi.fn()}
      onCheck={vi.fn()}
      onReset={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )

afterEach(cleanup)

describe('the Passung of an automatic fit', () => {
  it('an unapproved proposal is «ungemessen» and says what to do about it', () => {
    show()
    expect(screen.getByText(C.lampAutoHead)).toBeTruthy()
    expect(screen.getByText(C.chipAuto)).toBeTruthy()
    expect(screen.getByText(C.warnAuto)).toBeTruthy()
  })

  it('an approved fit is linked: no «ungemessen», no warning — and still no ⌀', () => {
    const { container } = show({ approved: true })
    expect(screen.getByText(C.lampApprovedHead)).toBeTruthy()
    expect(screen.queryByText(C.chipAuto)).toBeNull()
    expect(screen.queryByText(C.warnAuto)).toBeNull()
    expect(screen.getByText(C.lampApprovedBody)).toBeTruthy()
    expect(container.textContent).not.toContain('⌀')
  })

  it('one operator point of their own puts the proposal wording back — a correction is underway', () => {
    show({ approved: true, realPoints: 1 })
    expect(screen.getByText(C.autoOnePoint)).toBeTruthy()
    expect(screen.getByText(C.autoOneBody)).toBeTruthy()
  })
})
