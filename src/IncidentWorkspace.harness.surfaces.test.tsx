// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { BoardAnno, MittelEntry } from './types'
import { AUTH, SYM, rec, registerHarnessHooks, lastMap, lastBoard, meta, truck, workspaceTree, settle, mount, key, mode, openPlan, boardIds } from './IncidentWorkspace.harness.setup'
import { georefDispatch } from './lib/georefMode'
import { appConfig } from './config/appConfig'

/*
 * The workspace harness (shared setup: IncidentWorkspace.harness.setup.tsx) — the surfaces:
 *
 *   (a) the keyboard: one window listener routes K/C/A/R, digits, 0, ⌘Z and ⌘D by surface; an
 *       open modal leaves every key alone; an alignment session swallows navigation.
 *   (k) Koordinaten is a tool like any other: arming one ends the other.
 *   (b) the ONE timeline: a Karte commit and a plan step, taken back in order by ⌘Z — across a
 *       surface switch that unmounts the plan (its stacks live here, not in the Whiteboard).
 *   (d) the render budget: how many commits mount + idle cost, against a recorded baseline — a
 *       move that adds a memo, a state or an effect-order change shows up here first.
 *   (h) the phone FAB stays off the Atemschutz board.
 *   (l) «Unterirdische Bauten» on the Einsatz map.
 */

vi.mock('./lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/auth')>()
  const logout = () => Promise.resolve()
  // one stable value per role, so a render never hands the workspace a «new» user
  const valueOf = (role: typeof AUTH.role) => ({
    user: { id: 'u1', username: 'fu', display_name: 'FU Test', role, color: null, last_login: null },
    loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout,
  })
  const values = { editor: valueOf('editor'), el: valueOf('el'), viewer: valueOf('viewer') }
  return { ...mod, useAuth: () => values[AUTH.role] }
})
vi.mock('./lib/useSymbols', async (importOriginal) => ({ ...(await importOriginal<typeof import('./lib/useSymbols')>()), useSymbols: () => SYM }))
vi.mock('./components/MapView', () => ({
  MapView: (p: Record<string, unknown>) => { rec.map.push(p); return <div data-testid="mapview" /> },
}))
vi.mock('./components/Whiteboard', async () => {
  const { useBoardDoc } = await vi.importActual<typeof import('./components/useBoardDoc')>('./components/useBoardDoc')
  type P = Omit<Parameters<typeof useBoardDoc>[0], 'selId' | 'setSelId' | 'editId' | 'setEditId'> & { keysRef?: { current: unknown }; fitRef?: { current: unknown } }
  function FakeBoard(p: P) {
    rec.board.push(p as unknown as Record<string, unknown>)
    const [selId, setSelId] = useState<string | null>(null)
    const [editId, setEditId] = useState<string | null>(null)
    const doc = useBoardDoc({ ...p, selId, setSelId, editId, setEditId })
    rec.boardDoc = doc as unknown as { commit: (next: unknown[]) => void }
    if (p.keysRef) p.keysRef.current = rec.planKeys
    if (p.fitRef) p.fitRef.current = rec.planFit
    return <div data-testid="whiteboard" />
  }
  return { Whiteboard: FakeBoard }
})
// the Mittel surface as a prop recorder: the entries it is handed, and its save door
vi.mock('./components/MittelView', () => ({
  MittelView: (p: Record<string, unknown> & { entries: MittelEntry[] }) => {
    rec.mittel.push(p)
    return <ul data-testid="mittel">{p.entries.map((e) => <li key={e.id}>{e.label}</li>)}</ul>
  },
}))
// the Rapport's own chunk, prefetched on idle — not part of any contract here
// …recording its props: `events` is the Verlauf as the workspace holds it, which is how (e) reads
// the rows an act wrote without mounting the Verlauf drawer
vi.mock('./components/ReportPreflight', () => ({
  ReportPreflight: (p: { events: { text?: string }[] }) => { rec.report = p; return null },
  requestReportStep: () => {},
}))
vi.mock('./lib/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/ui')>()
  return { ...mod, confirmDialog: () => { rec.confirms++; return Promise.resolve(rec.answers.length ? rec.answers.shift()! : rec.answer) } }
})
// a surface that crashes is caught by its SurfaceBoundary, remounted, and the assertions would run
// against the fresh tree and pass — so every boundary report is recorded and fails the test
vi.mock('./lib/reportError', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/reportError')>()),
  reportClientError: (err: unknown, ctx: { kind?: string; surface?: string } = {}) => {
    rec.reported.push(`${ctx.kind ?? '?'}${ctx.surface ? `(${ctx.surface})` : ''}: ${err instanceof Error ? err.message : String(err)}`)
  },
}))
vi.mock('./lib/mediaQueue', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/mediaQueue')>()
  return { ...mod, flushMediaQueue: async (...a: Parameters<typeof mod.flushMediaQueue>) => { rec.order.push('flush'); return mod.flushMediaQueue(...a) } }
})

registerHarnessHooks()

describe('(a) the keyboard routes by surface', () => {
  // owner on #383 (review round 4): only «Karte & Objekte» stops at the base map's last sharp zoom;
  // the Einsatz keeps 21 for precise placement (lib/mapView · mapMaxZoom without the cap)
  it('the Einsatz map does not ask for the base map\'s zoom cap', async () => {
    await mount()
    expect((lastMap() as unknown as { zoomCapAtBase?: boolean }).zoomCapAtBase).toBeFalsy()
  })

  it('K / C / A / R switch surfaces, each claiming the key', async () => {
    await mount()
    expect(mode()).toBe('map')
    for (const [k, m] of [['c', 'checklists'], ['a', 'atemschutz'], ['r', 'rapport'], ['k', 'map']] as const) {
      expect(key(k).defaultPrevented).toBe(true)
      expect(mode()).toBe(m)
    }
  })

  it('a digit with no module of that number is inert — but still claimed', async () => {
    await mount()
    expect(key('7').defaultPrevented).toBe(true)
    expect(mode()).toBe('map')
  })

  it('0 fits the Plan through its exposed fit; on the Karte it never reaches the Plan', async () => {
    await mount()
    expect(key('0').defaultPrevented).toBe(true)
    expect(rec.planFit).not.toHaveBeenCalled()
    await openPlan('tafel')
    key('0')
    expect(rec.planFit).toHaveBeenCalledTimes(1)
  })

  it('⌘D duplicates the Karte selection; on a Plan it is the board’s own duplicate', async () => {
    await mount()
    act(() => lastMap().onSelect(truck))
    expect(key('d', { metaKey: true }).defaultPrevented).toBe(true)
    await settle()
    expect(lastMap().entities.filter((e) => e.symbol === 'VKF Fahrzeug')).toHaveLength(2)
    await openPlan('tafel')
    key('d', { ctrlKey: true })
    expect(rec.planKeys.duplicate).toHaveBeenCalledTimes(1)
  })

  it('⌘D on a surface that cannot duplicate does nothing and claims nothing', async () => {
    await mount()
    key('c')
    expect(key('d', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('a tool key reaches the surface that is showing', async () => {
    await mount()
    await openPlan('tafel')
    key('l')
    expect(rec.planKeys.pickTool).toHaveBeenCalledWith('line')
  })

  it('an open modal owns the keyboard — nothing routes behind it', async () => {
    await mount()
    key('?') // Hilfe
    await settle()
    expect(key('c').defaultPrevented).toBe(false)
    expect(mode()).toBe('map')
  })

  it('an alignment session swallows navigation — only its own Karte/Modul pair stays reachable', async () => {
    await mount()
    act(() => georefDispatch({ type: 'start', planId: 'tafel', pairs: [], aspect: 1.414 }))
    try {
      expect(key('c').defaultPrevented).toBe(true)
      expect(mode()).toBe('map')
      expect(key(']', { metaKey: true }).defaultPrevented).toBe(true)
      expect(mode()).toBe('map')
      expect(key('7').defaultPrevented).toBe(true)
      expect(mode()).toBe('map')
    } finally {
      act(() => georefDispatch({ type: 'end' }))
    }
  })
})

// UX sweep M1 (20.10.2026, owner: «any tool should end the coordinate mode, and vice versa»):
// Koordinaten stayed on under every tool and silently took the taps the armed tool's dock asked for.
describe('(k) Koordinaten is a tool like any other', () => {
  const picking = () => (lastMap() as unknown as { picking: boolean }).picking
  const placing = () => (lastMap() as unknown as { placing: boolean }).placing

  it('arming a tool ends the crosshair', async () => {
    await mount()
    key('x')
    expect(picking()).toBe(true)
    key('l')
    expect(picking()).toBe(false)
    expect(placing()).toBe(true)
  })

  it('entering it puts the armed tool down — and asks about its open draft; «Speichern» keeps it', async () => {
    await mount()
    key('f') // Fläche, tapped corners
    const onMapClick = (lastMap() as unknown as { onMapClick: (c: [number, number]) => void }).onMapClick
    act(() => { onMapClick([7.6, 47.5]); onMapClick([7.601, 47.5]); onMapClick([7.601, 47.501]) })
    rec.answers.push(true) // «Speichern»
    key('x')
    await settle()
    expect(rec.confirms).toBe(1)
    expect(picking()).toBe(true)
    expect(placing()).toBe(false)
    expect(lastMap().drawings.filter((d) => d.kind === 'area')).toHaveLength(1)
  })
})

describe('(b) one timeline across the Karte and a Plan', () => {
  const note = (id: string): BoardAnno => ({ id, kind: 'text', x: 0.5, y: 0.5, floor: 0, text: id })

  it('a Karte commit then a plan step come back in order — across the plan’s unmount', async () => {
    await mount()
    // the Karte: a freehand Linie, committed through the ordinary funnel
    key('l')
    act(() => lastMap().onFreehand([[7.6, 47.5], [7.61, 47.51]]))
    await settle()
    expect(lastMap().drawings).toHaveLength(1)
    // the Plan: one step, laid down exactly as the Whiteboard lays one (useBoardDoc · commit)
    await openPlan('tafel')
    act(() => rec.boardDoc!.commit([...lastBoard()!.annos, note('n1')]))
    await settle()
    expect(boardIds()).toContain('n1')
    // away and back: the board unmounts on the Karte and mounts again
    key('k'); await settle()
    await openPlan('tafel')
    expect(boardIds()).toContain('n1')
    // ⌘Z: the plan step first (the latest)…
    key('z', { metaKey: true }); await settle()
    expect(boardIds()).not.toContain('n1')
    key('k'); await settle()
    expect(lastMap().drawings).toHaveLength(1)
    // …then the Karte's line, from wherever we stand
    key('z', { metaKey: true }); await settle()
    expect(lastMap().drawings).toHaveLength(0)
    // ↷ brings them back in the same chronology
    key('z', { metaKey: true, shiftKey: true }); await settle()
    expect(lastMap().drawings).toHaveLength(1)
  })

  it('a plan step is undone while the plan is NOT mounted — its stack lives in the workspace', async () => {
    await mount()
    await openPlan('tafel')
    act(() => rec.boardDoc!.commit([...lastBoard()!.annos, note('n2')]))
    await settle()
    key('k'); await settle()
    const renders = rec.board.length
    key('z', { metaKey: true }); await settle()
    expect(rec.board.length).toBe(renders) // nothing re-mounted the board to do it
    await openPlan('tafel')
    expect(boardIds()).not.toContain('n2')
  })
})

describe('(d) the render budget', () => {
  // Recorded 23.09.2026 on the code before the split: 4 on every one of repeated runs (mount, the
  // IndexedDB hydrate, the 404s settling). A hook extraction must not RAISE it: an added state, a changed effect
  // order or a new unstable identity lands here as extra commits before it lands in the field.
  const MOUNT_IDLE_COMMITS = 4

  it('mount + idle stays within the recorded number of commits', async () => {
    let commits = 0
    const { tree } = workspaceTree(meta(), {}, () => { commits++ })
    render(tree)
    await settle(60); await settle(60); await settle(60)
    expect(commits).toBeLessThanOrEqual(MOUNT_IDLE_COMMITS)
  })
})

/* N9 (staging r2): on the phone the Eintrag FAB sat on the third crew's «Kontakt». It is not
   drawn over the Atemschutz board; everywhere else it stays. */
describe('(h) the phone FAB never sits over the Atemschutz board', () => {
  it('shows on the Karte and is gone on the Trupps page', async () => {
    const before = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q.includes('max-width: 600px'), media: q, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      await mount()
      expect(document.querySelector('.fab-entry')).toBeTruthy()
      key('a')
      await settle()
      expect(mode()).toBe('atemschutz')
      expect(document.querySelector('.fab-entry')).toBeNull()
    } finally {
      window.matchMedia = before
    }
  })
})

/* Karte review round 5 (owner, 18.10.2026): «activate underground by default and also show it on the
   normal map (during an incident)» — lib/underground. */
describe('(l) «Unterirdische Bauten» on the Einsatz map', () => {
  it('is on without a tap: asked once, drawn first (under the ERG rings, drawings and symbols), switchable in Ebenen', async () => {
    const sq = (lng: number, lat: number, d: number) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
    const set = { enabled: true, fetchedAt: '2026-10-18T03:00:00+00:00', count: 1, geometry: { type: 'MultiPolygon', coordinates: [[sq(7.6, 47.5, 0.0002)]] } }
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u)
      if (url.includes('/api/reference/underground')) { asked.push(url); return new Response(JSON.stringify(set), { status: 200, headers: { 'content-type': 'application/json' } }) }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }))
    await mount()
    type Ov = { id: string; layer: string; minzoom?: number; fillOpacity?: number; lineDasharray?: number[] }
    const overlays = () => (lastMap().preparedOverlays ?? []) as Ov[]
    const visible = (id: string) => (lastMap().isVisible as (l: string) => boolean)(id)
    await waitFor(() => expect(overlays()[0]?.id).toBe('underground'))
    expect(asked).toHaveLength(1)
    const ov = overlays()[0]
    expect(ov).toMatchObject({ minzoom: 16, fillOpacity: 0 })
    expect(ov.lineDasharray).toBeTruthy()
    expect(visible(ov.layer)).toBe(true)
    // an Ebenen row like any other: off takes it off the map, «Standard» brings it back
    fireEvent.click(screen.getAllByRole('button', { name: /^Ebenen/ })[0])
    const row = () => screen.getByRole('button', { name: /^Unterirdische Bauten – / })
    expect(row().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(row())
    expect(visible(ov.layer)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.layerPanel.reset }))
    expect(visible(ov.layer)).toBe(true)
    expect(asked).toHaveLength(1)
  })
})
