// @vitest-environment jsdom
// 3am test r3, 25.09.2026: the armed line mode's hint stood only behind ⓘ, and the Gebäude picker
// showed a field of identical outlines with nothing marking the Einsatzort.
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// the picker reads its outlines from the IndexedDB cache first — a stored answer, no network.
// `stored.rings` is what the next COLD box answers; the picker caches per box, so each test that
// needs its own outlines uses its own centre.
const stored = vi.hoisted(() => ({ rings: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]] as [number, number][][] }))
vi.mock('../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idb')>()),
  idbGet: async () => stored.rings,
  idbSet: async () => {},
}))

import { ToolDock } from './ToolDock'
import { OsmOutline } from './OsmOutline'

afterEach(cleanup)

describe('ToolDock · the armed mode says what it expects', () => {
  it('renders the one-line hint beside the controls, ⓘ keeps the long text', () => {
    render(<ToolDock hint="Punkte tippen – ✓ schliesst die Linie ab" groups={[
      [{ type: 'close', onClick: () => {} }],
      [{ type: 'info', text: 'lang' }],
    ]} />)
    expect(screen.getByRole('status').textContent).toBe('Punkte tippen – ✓ schliesst die Linie ab')
    expect(screen.getByRole('button', { name: 'lang' })).toBeTruthy()
  })

  it('no hint, no row', () => {
    render(<ToolDock groups={[[{ type: 'close', onClick: () => {} }]]} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('Gebäude picker · the Einsatzort is marked', () => {
  const center: [number, number] = [7.5, 47.5]
  const base = { center, radiusM: 150, onAspect: () => {}, sW: 400, sH: 400 }

  it('the Einsatz coordinate is a target ring at its place in the outline box', async () => {
    render(<OsmOutline {...base} pin={center} />)
    const pin = await waitFor(() => screen.getByRole('img', { name: appConfig.copy.map.incidentHere }))
    expect(pin.style.left).toBe('50%')
    expect(pin.style.top).toBe('50%')
  })

  it('no coordinate, no ring — and none for a point outside the box', async () => {
    const { container } = render(<OsmOutline {...base} pin={null} />)
    await waitFor(() => expect(container.querySelector('polygon')).toBeTruthy())
    expect(screen.queryByRole('img', { name: appConfig.copy.map.incidentHere })).toBeNull()
    cleanup()
    const r = render(<OsmOutline {...base} pin={[7.6, 47.6]} />)
    await waitFor(() => expect(r.container.querySelector('polygon')).toBeTruthy())
    expect(screen.queryByRole('img', { name: appConfig.copy.map.incidentHere })).toBeNull()
  })
})

// 08.10.2026: with no building yet, the outline at the Einsatzort starts selected — the operator
// confirms instead of hunting for it. Never committed without the tap.
describe('Gebäude picker · the building at the Einsatzort is offered', () => {
  const copy = appConfig.copy.whiteboard
  // ±150 m box: one picker unit is 300 m, so 0.01 ≈ 3 m
  const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const at = (lng: number, lat: number) => {
    const center: [number, number] = [lng, lat]
    return { center, radiusM: 150, onAspect: () => {}, sW: 400, sH: 400, interactive: true }
  }
  const take = (n: number) => fillTemplate(copy.osmTransfer, { n })

  it('preselects the outline that contains the pin, says so, and commits only on «Übernehmen»', async () => {
    stored.rings = [sq(0.1, 0.1, 0.2, 0.2), sq(0.45, 0.45, 0.55, 0.55), sq(0.7, 0.7, 0.8, 0.8)]
    const onPick = vi.fn()
    const p = at(7.51, 47.51)
    render(<OsmOutline {...p} pin={p.center} onPick={onPick} />)
    const btn = await waitFor(() => screen.getByRole('button', { name: take(1) }))
    expect(screen.getByText(copy.osmPickHintHere)).toBeTruthy()
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(btn)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toHaveLength(1)
  })

  it('a deselected offer stays deselected through re-renders; another pick drops the note', async () => {
    stored.rings = [sq(0.45, 0.45, 0.55, 0.55), sq(0.7, 0.7, 0.8, 0.8)]
    const p = at(7.52, 47.52)
    const { container, rerender } = render(<OsmOutline {...p} pin={p.center} />)
    await waitFor(() => screen.getByRole('button', { name: take(1) }))
    const polys = () => container.querySelectorAll('polygon')
    fireEvent.pointerDown(polys()[0]) // the operator says: not this one
    expect(screen.queryByRole('button', { name: take(1) })).toBeNull()
    expect(screen.getByText(copy.osmPickHint)).toBeTruthy()
    // the parent re-renders with fresh (equal) arrays and handlers — no re-pick
    const q = at(7.52, 47.52)
    rerender(<OsmOutline {...q} onAspect={() => {}} pin={[7.52, 47.52]} />)
    expect(screen.queryByRole('button', { name: take(1) })).toBeNull()
    // their own choice wears no «the app marked this» note
    fireEvent.pointerDown(polys()[1])
    expect(screen.getByRole('button', { name: take(1) })).toBeTruthy()
    expect(screen.queryByText(copy.osmPickHintHere)).toBeNull()
  })

  it('no pick when two houses are about equally near the pin', async () => {
    stored.rings = [sq(0.51, 0.45, 0.6, 0.55), sq(0.4, 0.45, 0.49, 0.55)] // 3 m either side
    const p = at(7.53, 47.53)
    const { container } = render(<OsmOutline {...p} pin={p.center} />)
    await waitFor(() => expect(container.querySelectorAll('polygon')).toHaveLength(2))
    expect(screen.getByText(copy.osmPickHint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: take(1) })).toBeNull()
    expect(screen.queryByText(copy.osmPickHintHere)).toBeNull()
  })

  it('no offer over a legacy building (replacing) or without a coordinate', async () => {
    stored.rings = [sq(0.45, 0.45, 0.55, 0.55)]
    const p = at(7.54, 47.54)
    const r = render(<OsmOutline {...p} pin={p.center} replacing />)
    await waitFor(() => expect(r.container.querySelector('polygon')).toBeTruthy())
    expect(screen.getByText(copy.osmPickHintReplace)).toBeTruthy()
    cleanup()
    const r2 = render(<OsmOutline {...p} pin={null} />)
    await waitFor(() => expect(r2.container.querySelector('polygon')).toBeTruthy())
    expect(screen.getByText(copy.osmPickHint)).toBeTruthy()
  })
})
