// @vitest-environment jsdom
// The Karte's plan surface (owner, review round 3, 17.10.2026):
//   3 · «Auf der Karte» under the plan is gone — «Zurück» is the one way back;
//   4 · a calm chip says when the sharper picture of the view is still loading, and — offline,
//       not stored — that it needs the network, instead of staying blurry without a word.
// The reader (Whiteboard) is a stand-in that hands the test the context the Karte provides.
// Synthetic Musterdorf data.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContext } from 'react'
import { PlanSharpnessContext, type PlanSharpnessHooks } from '../../lib/planSharpness'
import type { StationObject } from '../../lib/api/stationReference'
import type { ViewerPlanDoc } from '../../lib/karte/plans'

const rec = vi.hoisted(() => ({ hooks: null as PlanSharpnessHooks | null }))
vi.mock('../../workspace/lazySurfaces', () => ({
  Whiteboard: () => {
    rec.hooks = useContext(PlanSharpnessContext)
    return <div data-testid="pdf" />
  },
}))

import { KarteSurface } from './KartePlans'

const OBJ: StationObject = {
  id: 'schloss', name: 'Schloss Musterdorf', kind: 'einsatzobjekt', address: 'Schlossgasse 9, 9999 Musterdorf', lat: 47.523773, lng: 7.570188,
  aliases: [], floors: [], egid: null, footprint: null, lastVisit: null,
  // aligned on the map — the plan the struck «Auf der Karte» used to be offered for
  plans: [{ id: 'plan:schloss:modul1', module: 'modul1', code: '1', title: 'Übersicht', pages: 1, georef: true, version: 1 }],
}
const DOC = {
  plan: OBJ.plans[0],
  doc: { id: 'plan:schloss:modul1', code: '1', title: 'Übersicht', imageUrl: '/api/reference/plan%3Aschloss%3Amodul1?v=1' },
} as unknown as ViewerPlanDoc
const sym = { ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} } as never

const mount = (over: { phone?: boolean; offline?: boolean } = {}) => {
  const onMap = vi.fn()
  const view = render(<KarteSurface obj={OBJ} doc={DOC} phone={over.phone ?? true} sym={sym} onMap={onMap} offline={over.offline} held />)
  return { onMap, view }
}
const report = (s: Parameters<PlanSharpnessHooks['report']>[0]) => act(() => { rec.hooks!.report(s) })
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => { vi.useFakeTimers(); rec.hooks = null })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('KarteSurface · the plan', () => {
  it('has «Zurück» as its one way back — no «Auf der Karte», even for an aligned plan', async () => {
    const { onMap } = mount()
    await act(async () => {})
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Zurück'])
    expect(screen.queryByText('Auf der Karte')).toBeNull()
    act(() => { buttons[0].click() })
    expect(onMap).toHaveBeenCalledOnce()
  })

  it('asks the reader to fetch the next zoom level ahead (the Karte has nothing prepared offline)', async () => {
    mount()
    await act(async () => {})
    expect(rec.hooks?.prefetchNext).toBe(true)
  })

  it('shows «Schärfere Ansicht wird geladen …» only after a moment, and drops it when the view is sharp', async () => {
    mount()
    await act(async () => {})
    report('loading')
    wait(200)
    expect(screen.queryByText(/Schärfere Ansicht/)).toBeNull()
    wait(150)
    expect(screen.getByRole('status').textContent).toBe('Schärfere Ansicht wird geladen …')
    report('sharp')
    expect(screen.queryByText(/Schärfere Ansicht/)).toBeNull()
  })

  it('a quick load never flashes the chip', async () => {
    mount()
    await act(async () => {})
    report('loading')
    wait(120)
    report('sharp')
    wait(1000)
    expect(screen.queryByText(/Schärfere Ansicht/)).toBeNull()
  })

  it('offline, a sharper tile that is not stored says it needs the network', async () => {
    mount({ offline: true })
    await act(async () => {})
    report('failed')
    wait(300)
    // (the lamp chip beside «Zurück» says «Auf diesem Gerät» for the PDF itself)
    expect(screen.getByText('Schärfere Ansicht nur mit Netz').closest('[role=status]')).toBeTruthy()
  })

  it('online, a tile that could not be had says so', async () => {
    mount({ phone: false })
    await act(async () => {})
    report('failed')
    wait(300)
    expect(screen.getByText('Schärfere Ansicht konnte nicht geladen werden')).toBeTruthy()
  })
})
