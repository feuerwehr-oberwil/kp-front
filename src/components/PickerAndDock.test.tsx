// @vitest-environment jsdom
// 3am test r3, 25.09.2026: the armed line mode's hint stood only behind ⓘ, and the Gebäude picker
// showed a field of identical outlines with nothing marking the Einsatzort.
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'

// the picker reads its outlines from the IndexedDB cache first — a stored answer, no network
vi.mock('../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idb')>()),
  idbGet: async () => [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]],
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
