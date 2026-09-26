// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, useState } from 'react'
import type { BoardAnno, Drawing, Entity, MittelEntry } from './types'
import type { MittelDraft } from './components/MittelView'

/*
 * The workspace as ONE component, mounted whole (23.09.2026) — the safety net for splitting
 * IncidentWorkspace.tsx into hooks. Four contracts that only exist at this level, because each
 * one is the workspace WIRING surfaces together rather than any surface on its own:
 *
 *   (a) the keyboard: one window listener routes K/C/A/R, digits, 0, ⌘Z and ⌘D by surface; an
 *       open modal leaves every key alone; an alignment session swallows navigation.
 *   (b) the ONE timeline: a Karte commit and a plan step, taken back in order by ⌘Z — across a
 *       surface switch that unmounts the plan (its stacks live here, not in the Whiteboard).
 *   (c) the Abschluss: cancel closes nothing; OK drains the media queue FIRST, then hands over.
 *   (d) the render budget: how many commits mount + idle cost, against a recorded baseline — a
 *       move that adds a memo, a state or an effect-order change shows up here first.
 *   (e) the two-device loop: a merge that changes nothing must write nothing back.
 *   (f) a merge reaches the screen: what another device wrote shows here, and this device's next
 *       save carries it — a slice the merge never handed to its setter is saved back as a delete.
 *   (i) a close on ANOTHER device: the same mount goes read-only, the alarm stops, one row says so.
 *   (j) a reopen with a crew inside: no instant «Überfällig» — the clock restarts at the reopen.
 *
 * The two heavy surfaces are prop recorders. The Plan's stand-in runs the REAL useBoardDoc, so
 * a plan step is exactly the checkpoint the Whiteboard lays down.
 */

const rec = vi.hoisted(() => ({
  map: [] as Record<string, unknown>[],
  board: [] as Record<string, unknown>[],
  boardDoc: null as null | { commit: (next: unknown[]) => void },
  planKeys: { pickTool: vi.fn(), zoom: vi.fn(), duplicate: vi.fn() },
  planFit: vi.fn(),
  order: [] as string[],
  answer: false,
  /** answers for the next confirms, in order — `answer` once they run out */
  answers: [] as (boolean | 'alt')[],
  confirms: 0,
  mittel: [] as Record<string, unknown>[],
  report: null as null | { events: { text?: string }[] },
}))
type MapProps = Record<string, unknown> & {
  entities: Entity[]; drawings: Drawing[]; onSelect: (e: Entity) => void; onFreehand: (c: [number, number][]) => void
}
type BoardProps = Record<string, unknown> & { annos: BoardAnno[]; activeId: string }
const lastMap = () => rec.map[rec.map.length - 1] as MapProps
const lastBoard = () => rec.board[rec.board.length - 1] as BoardProps | undefined

vi.mock('./lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/auth')>()
  const user = { id: 'u1', username: 'fu', display_name: 'FU Test', role: 'editor' as const, color: null, last_login: null }
  const logout = () => Promise.resolve()
  const value = { user, loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout }
  return { ...mod, useAuth: () => value }
})
// the symbol pack is a network fetch with retries; the harness wants the surfaces up at once
const SYM = vi.hoisted(() => ({ ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} }))
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
vi.mock('./lib/mediaQueue', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/mediaQueue')>()
  return { ...mod, flushMediaQueue: async (...a: Parameters<typeof mod.flushMediaQueue>) => { rec.order.push('flush'); return mod.flushMediaQueue(...a) } }
})

import { IncidentWorkspace } from './IncidentWorkspace'
import { Meldeleiste } from './components/Meldeleiste'
import { WorkspaceSync } from './lib/api/workspaceSync'
import type { IncidentMeta } from './lib/api/incidents'
import type { Saved } from './lib/workspace'
import { georefDispatch } from './lib/georefMode'
import { appConfig } from './config/appConfig'
import { getMeldeleisteHost } from './lib/meldeleisteHost'
import { loadPrefs, savePrefs } from './lib/prefs'
import { fillTemplate } from './lib/format'

class RO { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  rec.map.length = 0; rec.board.length = 0; rec.order.length = 0; rec.boardDoc = null; rec.mittel.length = 0
  rec.answer = false; rec.answers.length = 0; rec.confirms = 0; rec.report = null
  vi.clearAllMocks()
  // every request the workspace makes (journal, audit, alignments, weather …) is simply absent
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

let seq = 0
const meta = (): IncidentMeta => ({
  // a fresh id per test: the per-incident IndexedDB slots never leak between cases
  id: `inc-h${++seq}`, divera_id: null, title: 'Harness', type: null, priority: null, address: 'Teststrasse 1',
  lat: 47.5, lng: 7.6, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-23T10:00:00Z', closed_at: null, is_archived: false, is_exercise: true,
  report_done_at: null, workspace_rev: 0, created_by: null, created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:00:00Z',
})
const truck = { id: 'p1', kind: 'symbol', symbol: 'VKF Fahrzeug', coord: [7.6, 47.5] } as Entity

type WsProps = React.ComponentProps<typeof IncidentWorkspace>
const workspaceTree = (m: IncidentMeta, over: Partial<WsProps>, onRender?: () => void) => {
  const onCompleteRapport = vi.fn(async () => { rec.order.push('complete'); return true })
  const tree = <IncidentWorkspace
    incidentMeta={m} incidents={[m]} workspace={{ entities: [truck] } as unknown as Saved} sync={new WorkspaceSync(m.id)}
    forceReadOnly={false} tabLockLost={false} onTakeOverTab={() => {}}
    onSwitchIncident={() => {}} onOpenHistory={() => {}} onOpenDivera={() => {}} onOpenDatenquellen={() => {}}
    needsReview={false} onReviewDone={() => {}} onEditMeta={() => {}}
    onCompleteRapport={onCompleteRapport}
    {...over}
  />
  return { tree: onRender ? <Profiler id="ws" onRender={onRender}>{tree}</Profiler> : tree, onCompleteRapport }
}
/** let the mount's promises (IndexedDB hydrate, the 404s, the lazy chunk) land */
const settle = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
const mount = async (over: Partial<WsProps> = {}) => {
  const { tree, onCompleteRapport } = workspaceTree(meta(), over)
  const utils = render(tree)
  await settle()
  return { ...utils, onCompleteRapport }
}
/** the form's own «Trupp anmelden» — the last of that name on the page (the door says it too) */
const lastBtn = (name: string) => { const all = screen.getAllByRole('button', { name }); return all[all.length - 1] }
const key = (k: string, o: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })
  act(() => { window.dispatchEvent(e) })
  return e
}
const mode = () => /mode-(\w+)/.exec(document.querySelector('.app')!.className)![1]
/** step the nav with ⌘] until the Plan surface shows `planId`. ⚠️ The Plan is a LAZY chunk: on
 *  a loaded machine its first import outlasts any fixed settle, and a second ⌘] pressed before
 *  the board is up steps straight past the plans — so each step waits for the board itself. */
const openPlan = async (planId: string) => {
  for (let i = 0; i < 8 && !(mode() === 'plans' && lastBoard()?.activeId === planId); i++) {
    key(']', { metaKey: true }); await settle()
    if (mode() === 'plans') await waitFor(() => expect(screen.getByTestId('whiteboard')).toBeTruthy(), { timeout: 10_000 })
  }
  expect(mode()).toBe('plans')
  expect(lastBoard()?.activeId).toBe(planId)
}
const boardIds = () => (lastBoard()?.annos ?? []).map((a) => a.id)

describe('(a) the keyboard routes by surface', () => {
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

describe('(c) the Abschluss', () => {
  const pressAbschluss = async () => {
    // the Einsatz menu (the title pill), then its «Einsatz abschliessen» row
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.incidentSwitcher.archive }))
    await settle()
  }

  it('cancel closes nothing and hands nothing over', async () => {
    const { onCompleteRapport } = await mount()
    rec.answer = false
    await pressAbschluss()
    expect(rec.confirms).toBe(1)
    expect(onCompleteRapport).not.toHaveBeenCalled()
  })

  /* A Sicherungstrupp still angemeldet (24.09.2026, D1 ⑦): the workspace wires the Abschluss's
     «nicht eingesetzt» to the card's own stand-down, and only after the final «Abschliessen». */
  const standing = {
    id: 'sich', no: 6, name: 'Muster Leo', entryPressureBar: 280, entryTime: '', lastContactTime: '',
    status: 'angemeldet', auftrag: 'sichern', readings: [],
  }
  const withSafety = () => ({ workspace: { entities: [truck], trupps: [standing] } as unknown as Saved })
  const statusOnBoard = async () => {
    key('a')
    await settle()
    return document.body.textContent ?? ''
  }

  it('«nicht eingesetzt», then «Abbrechen»: the Sicherungstrupp is still angemeldet', async () => {
    const { onCompleteRapport } = await mount(withSafety())
    rec.answers.push(true, false)
    await pressAbschluss()
    expect(rec.confirms).toBe(2)
    expect(onCompleteRapport).not.toHaveBeenCalled()
    // still at the door: its card offers «Im Einsatz», not the way back in of a closed Trupp
    expect(await statusOnBoard()).not.toContain(appConfig.copy.atemschutz.actEnterFirst)
  })

  it('«nicht eingesetzt», then «Abschliessen»: stood down through the card\'s own close-out, then handed over', async () => {
    const { onCompleteRapport } = await mount(withSafety())
    rec.answers.push(true, true)
    await pressAbschluss()
    // the stand-down takes one task before the handover (useAbschluss) — wait for it, not a clock
    await waitFor(() => expect(onCompleteRapport).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    expect(await statusOnBoard()).toContain(appConfig.copy.atemschutz.actEnterFirst)
  })

  it('OK drains the media queue FIRST, then hands the Einsatz over', async () => {
    const { onCompleteRapport } = await mount()
    rec.answer = true
    rec.order.length = 0
    await pressAbschluss()
    // the Verlauf and audit outboxes drain between the media and the handover (review of #235) —
    // an await more, which a loaded runner can stretch past the fixed settle
    await waitFor(() => expect(onCompleteRapport).toHaveBeenCalledTimes(1))
    expect(rec.order.slice(-2)).toEqual(['flush', 'complete'])
  })
})

describe('(i) closed on ANOTHER device while open here (N3, staging 25.09.2026)', () => {
  // App flips the live meta when the close is heard (App · onIncidentClosed) and hands the moment
  // down — no remount. The same mount must go read-only, stop the Atemschutz alarm (its Meldung is
  // the audible alarm's own row) and say what happened, with the time.
  it('the Karte locks, the alarm stops and one row says «auf einem anderen Gerät abgeschlossen»', async () => {
    const m = meta()
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const overdue = { id: 'tr-k', name: 'Tst Karl', status: 'aktiv', entryPressureBar: 300, entryTime: longAgo, lastContactTime: longAgo }
    const sync = new WorkspaceSync(m.id)
    const ws = { entities: [truck], trupps: [overdue] } as unknown as Saved
    const tree = (im: IncidentMeta, lifecycleElsewhere?: WsProps['lifecycleElsewhere']) => <><Meldeleiste />{workspaceTree(im, { sync, workspace: ws, lifecycleElsewhere }).tree}</>
    const { rerender } = render(tree(m))
    await settle(60); await settle(1_100) // the 1 Hz alarm tick
    const rows = () => [...document.querySelectorAll('.ml-row')].map((r) => r.textContent ?? '')
    expect(lastMap().readOnly).toBe(false)
    expect(rows().some((t) => t.includes('Tst Karl'))).toBe(true) // überfällig — the alarm is on

    const closedAt = new Date()
    rerender(tree({ ...m, is_archived: true, closed_at: closedAt.toISOString() }, { event: 'closed', at: closedAt.getTime() }))
    await settle(60); await settle(1_100)

    expect(lastMap().readOnly).toBe(true)
    expect(rows().some((t) => t.includes('Tst Karl'))).toBe(false) // the alarm stopped with the Einsatz
    const title = document.querySelector('.ml-title')?.textContent ?? ''
    expect(title).toBe(`Einsatz wurde auf einem anderen Gerät abgeschlossen (${String(closedAt.getHours()).padStart(2, '0')}:${String(closedAt.getMinutes()).padStart(2, '0')})`)
    expect(document.querySelector('.app')).toBeTruthy() // the same workspace, not a jump elsewhere
    // …and never over the Rapport, whose head carries the page's own actions (V3)
    key('r'); await settle()
    expect([...document.querySelectorAll('.ml-title')].some((t) => t.textContent?.includes('anderen Gerät'))).toBe(false)
    key('k'); await settle()

    // …and «Wieder öffnen» on another device: live again, in place, the alarm back, one row
    const reopenedAt = new Date()
    rerender(tree({ ...m, is_archived: false, closed_at: closedAt.toISOString() }, { event: 'reopened', at: reopenedAt.getTime() }))
    await settle(60); await settle(1_100)
    expect(lastMap().readOnly).toBe(false)
    expect(rows().some((t) => t.includes('Tst Karl'))).toBe(true) // the Tafel is watched again
    const hhmm = `${String(reopenedAt.getHours()).padStart(2, '0')}:${String(reopenedAt.getMinutes()).padStart(2, '0')}`
    const titles = [...document.querySelectorAll('.ml-title')].map((t) => t.textContent)
    expect(titles).toContain(`Einsatz wurde auf einem anderen Gerät wieder geöffnet (${hhmm})`)
    expect(titles.some((t) => t?.includes('abgeschlossen'))).toBe(false) // the close's row is gone
  })

  it('an Einsatz OPENED closed says nothing of the kind — nobody saw it happen', async () => {
    const m = { ...meta(), is_archived: true, closed_at: '2026-09-25T10:00:00Z' }
    render(<><Meldeleiste />{workspaceTree(m, { forceReadOnly: true }).tree}</>)
    await settle(60)
    expect(document.querySelector('.ml-title')?.textContent ?? '').not.toMatch(/anderen Gerät/)
  })
})

describe('(j) «Wieder öffnen» with a crew still inside (staging r3, F4)', () => {
  it('holds the alarm until the reopen row is there, then restarts the clock at it — one row, no instant «Überfällig»', async () => {
    const m = meta()
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const overdue = { id: 'tr-k', no: 1, name: 'Tst Karl', status: 'aktiv', entryPressureBar: 300, entryTime: longAgo, lastContactTime: longAgo }
    const closedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const reopenAt = new Date(Date.now() - 3 * 60_000).toISOString()
    const closeRow = { id: 'sysclose', t: '', at: closedAt, icon: 'flag', text: 'Einsatz abgeschlossen', lifecycle: 'closed' }
    const reopenRow = { id: 'sysreopen', t: '', at: reopenAt, icon: 'undo', text: 'Einsatz wiedereröffnet (Nachtrag)', lifecycle: 'reopened' }
    let serverRows: unknown[] = [closeRow]
    const posted: { id: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/journal') && (init?.method ?? 'GET') === 'GET') {
        const entries = serverRows.map((row, i) => ({ seq: i + 1, row }))
        return new Response(JSON.stringify({ entries, latest_seq: entries.length }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/journal') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { entries: { id: string }[] }
        posted.push(...body.entries)
        return new Response(JSON.stringify({ entries: [], latest_seq: serverRows.length }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }))
    const sync = new WorkspaceSync(m.id)
    const ws = { entities: [truck], trupps: [overdue] } as unknown as Saved
    const heardAt = Date.now()
    const tree = (im: IncidentMeta, lifecycleElsewhere?: WsProps['lifecycleElsewhere']) => <><Meldeleiste />{workspaceTree(im, { sync, workspace: ws, lifecycleElsewhere }).tree}</>
    // the device opens it closed (a close heard earlier), then the reopen arrives by the poll…
    const { rerender } = render(tree({ ...m, is_archived: true, closed_at: closedAt }))
    await settle(60)
    rerender(tree({ ...m, is_archived: false, closed_at: closedAt }, { event: 'reopened', at: heardAt }))
    await settle(60); await settle(1_100)
    const rows = () => [...document.querySelectorAll('.ml-row')].map((r) => r.textContent ?? '')
    // …before the Verlauf has the reopen row: the alarm HOLDS rather than ring across the closed hour
    expect(rows().some((t) => t.includes('Tst Karl'))).toBe(false)

    // the reopen row arrives (the journal loop's next round)
    serverRows = [closeRow, reopenRow]
    await settle(2_600); await settle(1_100)
    // the clock restarted at the reopen: still no alarm, and ONE row under the derived id
    expect(rows().some((t) => t.includes('Tst Karl'))).toBe(false)
    const restart = posted.filter((r) => r.id === 'azro-sysreopen-tr-k')
    expect(restart).toHaveLength(1)
    // …and the notice names the REOPEN's time (the server row), not when this device heard it (N6)
    const hhmm = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
    const titles = [...document.querySelectorAll('.ml-title')].map((t) => t.textContent)
    expect(titles).toContain(`Einsatz wurde auf einem anderen Gerät wieder geöffnet (${hhmm(Date.parse(reopenAt))})`)
  }, 20_000)
})

describe('(e) a hydrate that changes nothing writes nothing', () => {
  // The two-device loop (IncidentWorkspace · the georef re-bake's «really» note): every hydrate
  // rebuilds the fits, and a re-bake or a save on identity alone would mark the store dirty after
  // a merge that changed nothing — the other device then pulls, re-applies, and pushes back, and
  // each round wipes both undo stacks. Two identical hydrates must leave the sync untouched.
  it('two identical merges in a row: no save, nothing unsynced', async () => {
    const m = meta()
    const sync = new WorkspaceSync(m.id)
    const { tree } = workspaceTree(m, { sync })
    render(tree)
    await settle(60); await settle(60)
    const save = vi.spyOn(sync, 'save')
    const blob = { entities: [truck] } as unknown as Parameters<NonNullable<typeof sync.onApplyMerged>>[0]
    expect(sync.onApplyMerged).toBeTypeOf('function')
    act(() => sync.onApplyMerged!(blob, 1))
    await settle(60)
    act(() => sync.onApplyMerged!(blob, 1))
    await settle(60)
    expect(save).not.toHaveBeenCalled()
    expect(sync.hasUnsynced).toBe(false)
  })
})

describe('(f) a merge reaches the screen', () => {
  // Live on production until 25.09.2026: applyWorkspace handed every synced slice to its setter
  // except `mittel`. Another device's Mittel line never showed here, and this device's next save
  // — whose ancestor DID hold it — carried the stale list, which the three-way merge reads as a
  // local delete (delete wins). The line vanished from every device.
  const row = (id: string, label: string): MittelEntry => ({ id, label, unit: 'Stk', menge: 1, at: '2026-09-25T08:00:00Z' })
  const lastMittel = () => rec.mittel[rec.mittel.length - 1] as { entries: MittelEntry[]; onSave: (d: MittelDraft) => void }
  const shown = () => Array.from(screen.getByTestId('mittel').querySelectorAll('li')).map((li) => li.textContent)

  it('another device’s Mittel line shows after the merge, and the next save keeps it', async () => {
    const m = meta()
    savePrefs({ ...loadPrefs(), mode: 'mittel', modeIncidentId: m.id }) // open straight on Mittel
    const sync = new WorkspaceSync(m.id)
    const mine = row('m-mine', 'Schlauch 55')
    const { tree } = workspaceTree(m, { sync, workspace: { entities: [truck], mittel: [mine] } as unknown as Saved })
    render(tree)
    await settle(60); await settle(60)
    expect(shown()).toEqual(['Schlauch 55'])

    const theirs = row('m-theirs', 'Ölbinder')
    const merged = { entities: [truck], mittel: [mine, theirs] } as unknown as Parameters<NonNullable<typeof sync.onApplyMerged>>[0]
    act(() => sync.onApplyMerged!(merged, 1))
    await settle(60)
    expect(shown()).toEqual(['Schlauch 55', 'Ölbinder'])

    // this device records its own line — the save must carry the other device's too
    const save = vi.spyOn(sync, 'save')
    act(() => lastMittel().onSave({ label: 'Absperrband', unit: 'Rolle', menge: 2 }))
    await settle(60)
    expect(save).toHaveBeenCalled()
    const saved = save.mock.calls[save.mock.calls.length - 1][0] as unknown as Saved
    expect(saved.mittel?.map((e) => e.label)).toEqual(['Schlauch 55', 'Ölbinder', 'Absperrband'])
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

describe('(e) acts on the picture that the Verlauf used to miss (3am test r3, 25.09.2026)', () => {
  const rows = async () => { key('r'); await settle(60); return (rec.report?.events ?? []).map((e) => e.text) }

  it('«+ OG» names the storey on its ↶ (its Verlauf row comes with #226)', async () => {
    const stack = {
      src: [[[0, 0], [1, 0], [1, 1], [0, 1]]], orientDeg: 0, northUp: false,
      rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]], ring: [[0, 0], [1, 0], [1, 1], [0, 1]], ringAspect: 1,
      floors: [0, 1, 2],
    }
    const { tree } = workspaceTree(meta(), { workspace: { entities: [truck], building: stack } as unknown as Saved })
    render(tree)
    await settle()
    await openPlan('gebaeude')
    act(() => (lastBoard() as BoardProps & { onAddFloor: (dir: 1 | -1) => void }).onAddFloor(1))
    await settle()
    expect((lastBoard() as BoardProps & { building: { floors: number[] } }).building.floors).toEqual([0, 1, 2, 3])
    // 3am test r4, 26.09.2026: three adds read «Geschoss hinzugefügt» ×3, naming no storey
    expect(screen.getByRole('button', { name: new RegExp(fillTemplate(appConfig.copy.whiteboard.floorAddedToast, { floor: '3. OG' })) })).toBeTruthy()
  })

  it('«Lösen» on a docked Gefahrentafel writes «… von «TLF» gelöst»', async () => {
    const host = { id: 'h1', kind: 'symbol', symbol: 'VKF Fahrzeug', label: 'TLF', coord: [7.6, 47.5] } as Entity
    const placard = { id: 'pl1', kind: 'symbol', symbol: appConfig.symbols.placardName, label: 'Tafel', coord: [7.6, 47.5], dockedTo: 'h1' } as Entity
    const { tree } = workspaceTree(meta(), { workspace: { entities: [host, placard] } as unknown as Saved })
    render(tree)
    await settle()
    act(() => lastMap().onSelect(placard))
    await settle()
    fireEvent.click(screen.getAllByText(appConfig.copy.contextPanel.dockedRelease)[0])
    await settle()
    expect(lastMap().entities.find((e) => e.id === 'pl1')?.dockedTo).toBeUndefined()
    expect(await rows()).toContain(fillTemplate(appConfig.copy.log.placardUndocked, { name: 'Tafel', host: 'TLF' }))
  })
})

/* ── Staging walk-through r2 (25.09.2026), N1: every Gast typed into the Trupp form was filed
   TWICE in the Anwesenheit, and the Verlauf printed ids. The workspace wiring is what broke — the
   save filed the Gäste, then the crew filing read a render-old Anwesenheit and filed them again. */
describe('(f) Gäste from the Trupp form reach the Anwesenheit once', () => {
  it('two Gäste in, two people on the Anwesenheit — each once', async () => {
    await mount()
    key('a')
    await settle()
    fireEvent.click(screen.getAllByRole('button', { name: appConfig.copy.atemschutz.newTrupp })[0])
    await settle()
    const az = appConfig.copy.atemschutz
    for (const name of ['Tst Anna', 'Tst Ben']) {
      fireEvent.change(screen.getByLabelText(az.teamSearchPlaceholder), { target: { value: name } })
      fireEvent.click(screen.getByRole('option', { name: new RegExp(`${name}.*als Gast`) }))
    }
    fireEvent.click(lastBtn(az.start))
    await settle(60)
    fireEvent.click(screen.getAllByRole('button', { name: 'Anwesenheit' })[0])
    await settle(300)
    const text = document.body.textContent ?? ''
    // the Anwesenheit's own head count (the roster list itself needs a network the harness has
    // not got): two people, not four
    expect(text).toMatch(/(?<!\d)2 anwesend/)
  })
})

/* staging r3 F1: a registration with two Gäste left «Rückgängig: Anwesenheit» on top — it stripped
   the crew's AS-Funktion, kept them present and kept the Trupp. One act, one ↶. */
describe('(f2) a Trupp registration with its Gäste is ONE undo step', () => {
  it('↶ reads «Trupp … angemeldet» and takes the Trupp and the Gäste it filed back together', async () => {
    await mount()
    key('a')
    await settle()
    const az = appConfig.copy.atemschutz
    fireEvent.click(screen.getAllByRole('button', { name: az.newTrupp })[0])
    await settle()
    for (const name of ['Tst Anna', 'Tst Ben']) {
      fireEvent.change(screen.getByLabelText(az.teamSearchPlaceholder), { target: { value: name } })
      fireEvent.click(screen.getByRole('option', { name: new RegExp(`${name}.*als Gast`) }))
    }
    fireEvent.click(lastBtn(az.start))
    await settle(60)
    // the label ↶ promises is the Trupp's own, not «Anwesenheit»
    const undoBtn = screen.getAllByRole('button').find((b) => (b.getAttribute('aria-label') ?? b.getAttribute('title') ?? '').startsWith('Rückgängig:'))
    const promise = undoBtn?.getAttribute('aria-label') ?? undoBtn?.getAttribute('title') ?? ''
    expect(promise).toContain('angemeldet')
    expect(promise).not.toContain(appConfig.copy.undoDomains.anwesenheit)
    key('z', { metaKey: true }); await settle(60)
    // the Trupp is off the board…
    expect(document.body.textContent ?? '').not.toContain('Tst Anna / Tst Ben')
    // …and the two people it filed are off the Anwesenheit
    fireEvent.click(screen.getAllByRole('button', { name: 'Anwesenheit' })[0])
    await settle(300)
    expect(document.body.textContent ?? '').not.toMatch(/(?<!\d)2 anwesend/)
    expect(document.body.textContent ?? '').toMatch(/(?<!\d)0 anwesend/)
  })
})

/* N2: a crew registered on the Atemschutz-Link (names, no ids — the link cannot write the record)
   is filed by the editor device that SEES it, under derived ids, once. */
describe('(g) a Link-registered crew reaches the Anwesenheit through the editor device', () => {
  it('files both names once when the Trupp arrives, and nothing more on the next render', async () => {
    const linkTrupp = {
      id: 'tl1', no: 1, name: 'Tst Ida', members: ['Tst Jan'], entryPressureBar: 300, entryTime: '', lastContactTime: '',
      status: 'angemeldet', readings: [],
    }
    await mount({ workspace: { entities: [truck], trupps: [linkTrupp] } as unknown as Saved })
    await settle(60)
    fireEvent.click(screen.getAllByRole('button', { name: 'Anwesenheit' })[0])
    await settle(120)
    expect(document.body.textContent ?? '').toMatch(/(?<!\d)2 anwesend/)
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

/* staging r5 N3: the Meldeleiste paints INSIDE the open Einsatz's `.app` (lib/meldeleisteHost) —
   beside it, at App root, it outranked the whole stacking context and lay over the Einsatz menu. */
describe('(i) the workspace is where the Meldeleiste paints', () => {
  it('registers its .app as the strip\'s host, and lets go when it unmounts', async () => {
    const { unmount } = await mount()
    expect(getMeldeleisteHost()?.classList.contains('app')).toBe(true)
    unmount()
    expect(getMeldeleisteHost()).toBeNull()
  })
})
