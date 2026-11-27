// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { BoardAnno, MittelEntry, Trupp } from './types'
import { AUTH, SYM, rec, registerHarnessHooks, lastMap, lastBoard, meta, truck, workspaceTree, settle, key, mode, openPlan } from './IncidentWorkspace.harness.setup'
import type { Saved } from './lib/workspace'
import { WorkspaceSync } from './lib/api/workspaceSync'
import { georefDispatch } from './lib/georefMode'
import { loadPrefs, savePrefs } from './lib/prefs'

/*
 * The workspace harness (shared setup: IncidentWorkspace.harness.setup.tsx) — the hidden Karte:
 *
 *   (p) the Karte stays mounted under every other surface, and it renders only while it can be
 *       seen (workspace/MapStage · frozen). A commit on the Trupps, the Tafel or the Rapport costs
 *       it nothing; the first commit that shows it again hands it the latest of everything.
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

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const crew = { id: 'tr-a', no: 1, name: 'Tst Anna', status: 'aktiv', entryPressureBar: 300, entryTime: ago(5), lastContactTime: ago(4) }
/** the MapView renders that happened before the FIRST commit that showed the Karte again */
let atShow: number | null = null
const open = async (opts: { on?: 'atemschutz' } = {}) => {
  const m = meta()
  if (opts.on) savePrefs({ ...loadPrefs(), mode: opts.on, modeIncidentId: m.id })
  atShow = null
  let hidden = false
  // the Profiler's onRender runs in the commit, after the DOM is written and before the browser
  // paints: the commit that puts `mode-map` on the root must already carry the catch-up render
  const { tree } = workspaceTree(m, { sync: new WorkspaceSync(m.id), workspace: { entities: [truck], trupps: [crew] } as unknown as Saved }, () => {
    const app = document.querySelector('.app')
    if (!app) return
    if (!app.classList.contains('mode-map')) hidden = true
    else if (hidden && atShow === null) atShow = rec.map.length
  })
  render(tree)
  await settle()
}
const contactOf = () => (lastMap().trupps as Trupp[]).find((t) => t.id === crew.id)?.lastContactTime

describe('(p) the hidden Karte does not render', () => {
  it('three Kontakt taps on the Trupps: 0 renders; back on the Karte it has the last contact in the commit that shows it', async () => {
    await open()
    key('a'); await settle()
    expect(mode()).toBe('atemschutz')
    const before = rec.map.length
    const contact = contactOf()
    for (let i = 0; i < 3; i++) { fireEvent.click(screen.getAllByRole('button', { name: /Kontakt/ })[0]); await settle() }
    expect(rec.map.length - before).toBe(0)
    key('k')
    expect(mode()).toBe('map')
    expect(atShow).toBe(before + 1)
    expect(contactOf()).not.toBe(contact)
  })

  it('a 40-move drag on the Tafel: 0 renders; back on the Karte it has the latest picture', async () => {
    await open()
    await openPlan('tafel')
    act(() => { rec.boardDoc!.commit([...lastBoard()!.annos, { id: 'n1', kind: 'text', x: 0.5, y: 0.5, floor: 0, text: 'n1' } as BoardAnno]) })
    await settle()
    const doc = rec.boardDoc as unknown as { pushPast: () => void; patch: (id: string, p: Partial<BoardAnno>) => void }
    const before = rec.map.length
    act(() => { doc.pushPast() })
    for (let i = 0; i < 40; i++) act(() => { doc.patch('n1', { x: 0.5 + i / 200 }) })
    await settle()
    expect(rec.map.length - before).toBe(0)
    key('k'); await settle()
    expect(atShow).toBe(before + 1)
  })

  it('ten keystrokes in a Rapport field: 0 renders', async () => {
    await open()
    key('r'); await settle(); await settle(200)
    expect(mode()).toBe('rapport')
    type Report = { reportMeta: Record<string, unknown>; onSaveMeta: (m: unknown) => void }
    const report = () => rec.report as unknown as Report
    const before = rec.map.length
    for (let i = 1; i <= 10; i++) { act(() => { report().onSaveMeta({ ...report().reportMeta, summary: 'Brand'.padEnd(i + 5, 'x') }) }); await settle(5) }
    expect(report().reportMeta.summary).toBe('Brandxxxxxxxxxx')
    expect(rec.map.length - before).toBe(0)
  })

  it('an Einsatz that opens on the Trupps still mounts the map once, with its first fit and its settle', async () => {
    await open({ on: 'atemschutz' })
    expect(mode()).toBe('atemschutz')
    expect(rec.map.length).toBeGreaterThanOrEqual(1)
    expect(lastMap().onSettled).toBeTypeOf('function')
    expect(lastMap().initialCenter).toBeTruthy()
  })
})

describe('(p) the shown Karte renders as before', () => {
  it('a Karte commit renders it at once', async () => {
    await open()
    const before = rec.map.length
    key('l')
    act(() => { lastMap().onFreehand([[7.6, 47.5], [7.61, 47.51]]) })
    expect(rec.map.length).toBeGreaterThan(before)
    expect(lastMap().drawings).toHaveLength(1)
  })

  it('the georef split over the Plan: armed, the map renders on a plan commit; ended, it stops', async () => {
    await open()
    await openPlan('tafel')
    const frozen = rec.map.length
    act(() => { georefDispatch({ type: 'start', planId: 'tafel', pairs: [], aspect: 1.414 }) })
    try {
      // arming shows the map: it catches up in that commit…
      expect(rec.map.length).toBeGreaterThan(frozen)
      const live = rec.map.length
      // …and a plan commit beside it renders it again – the split keeps it live
      act(() => { rec.boardDoc!.commit([...lastBoard()!.annos, { id: 'n2', kind: 'text', x: 0.4, y: 0.4, floor: 0, text: 'n2' } as BoardAnno]) })
      await settle()
      expect(rec.map.length).toBeGreaterThan(live)
    } finally {
      act(() => { georefDispatch({ type: 'end' }) })
    }
    await settle()
    const after = rec.map.length
    act(() => { rec.boardDoc!.commit([...lastBoard()!.annos, { id: 'n3', kind: 'text', x: 0.3, y: 0.3, floor: 0, text: 'n3' } as BoardAnno]) })
    await settle()
    expect(rec.map.length).toBe(after)
  })
})
