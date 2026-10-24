import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import type { BoardAnno, Drawing, Entity } from './types'
import { IncidentWorkspace } from './IncidentWorkspace'
import { WorkspaceSync } from './lib/api/workspaceSync'
import type { IncidentMeta } from './lib/api/incidents'
import type { Saved } from './lib/workspace'

/*
 * The workspace as ONE component, mounted whole (23.09.2026) — the safety net for splitting
 * IncidentWorkspace.tsx into hooks: the contracts that only exist at this level, because each one
 * is the workspace WIRING surfaces together rather than any surface on its own. The cases live in
 * `IncidentWorkspace.harness.<topic>.test.tsx`; this module is what they share.
 *
 * How a harness file uses it:
 *   · copy the `vi.mock(...)` block of an existing harness file VERBATIM — vi.mock is hoisted per
 *     test file and cannot live here. The stand-ins write into `rec` / read `AUTH` and `SYM` from
 *     this module; they only touch them when called (a render), never while the factory runs, which
 *     is why importing them across the hoist is safe.
 *   · call `registerHarnessHooks()` once at the top level, then mount with `mount()` /
 *     `workspaceTree()`.
 *
 * The two heavy surfaces are prop recorders. The Plan's stand-in runs the REAL useBoardDoc, so
 * a plan step is exactly the checkpoint the Whiteboard lays down.
 */

export const rec = {
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
  /** every `reportClientError` call — a boundary that caught a crash files one; afterEach fails on any */
  reported: [] as string[],
}
type MapProps = Record<string, unknown> & {
  entities: Entity[]; drawings: Drawing[]; onSelect: (e: Entity) => void; onFreehand: (c: [number, number][]) => void
}
export type BoardProps = Record<string, unknown> & { annos: BoardAnno[]; activeId: string }
export const lastMap = () => rec.map[rec.map.length - 1] as MapProps
export const lastBoard = () => rec.board[rec.board.length - 1] as BoardProps | undefined

/** the signed-in role – `editor` unless a case says otherwise (reset per test) */
export const AUTH = { role: 'editor' as 'editor' | 'el' | 'viewer' }
// the symbol pack is a network fetch with retries; the harness wants the surfaces up at once
export const SYM = { ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} }

class RO { observe() {} unobserve() {} disconnect() {} }
/** The jsdom gaps, the per-test reset of the recorders and the 404 network, and the crash guard. */
export function registerHarnessHooks() {
  beforeAll(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    // jsdom has none; the Atemschutz board scrolls an alarmed card into view
    Element.prototype.scrollIntoView = () => {}
  })
  beforeEach(() => {
    rec.map.length = 0; rec.board.length = 0; rec.order.length = 0; rec.boardDoc = null; rec.mittel.length = 0
    rec.answer = false; rec.answers.length = 0; rec.confirms = 0; rec.report = null; rec.reported.length = 0
    AUTH.role = 'editor'
    vi.clearAllMocks()
    // every request the workspace makes (journal, audit, alignments, weather …) is simply absent
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
  })
  afterEach(() => {
    cleanup(); vi.unstubAllGlobals()
    // a surface that crashed was caught by its SurfaceBoundary and remounted — the assertions ran
    // against the fresh tree and passed (D.3, 23.10.2026: el.scrollIntoView in the Atemschutz board)
    expect(rec.reported, 'a surface crashed and an error boundary caught it').toEqual([])
  })
  // let the last unmounted workspace's IndexedDB round-trips (the media queue's mount flush) land
  // while jsdom still stands — under a loaded full run they settled after the teardown and failed
  // the suite with «window is not defined» (useMediaQueue)
  afterAll(() => settle(100))
}

let seq = 0
export const meta = (): IncidentMeta => ({
  // a fresh id per test: the per-incident IndexedDB slots never leak between cases
  id: `inc-h${++seq}`, divera_id: null, title: 'Harness', type: null, priority: null, address: 'Teststrasse 1',
  lat: 47.5, lng: 7.6, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-23T10:00:00Z', closed_at: null, is_archived: false, is_exercise: true,
  report_done_at: null, workspace_rev: 0, created_by: null, created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:00:00Z',
})
export const truck = { id: 'p1', kind: 'symbol', symbol: 'VKF Fahrzeug', coord: [7.6, 47.5] } as Entity

export type WsProps = React.ComponentProps<typeof IncidentWorkspace>
export const workspaceTree = (m: IncidentMeta, over: Partial<WsProps>, onRender?: () => void) => {
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
export const settle = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
export const mount = async (over: Partial<WsProps> = {}) => {
  const { tree, onCompleteRapport } = workspaceTree(meta(), over)
  const utils = render(tree)
  await settle()
  return { ...utils, onCompleteRapport }
}
/** the form's own «Trupp anmelden» — the last of that name on the page (the door says it too) */
export const lastBtn = (name: string) => { const all = screen.getAllByRole('button', { name }); return all[all.length - 1] }
export const key = (k: string, o: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })
  act(() => { window.dispatchEvent(e) })
  return e
}
export const mode = () => /mode-(\w+)/.exec(document.querySelector('.app')!.className)![1]
/** step the nav with ⌘] until the Plan surface shows `planId`. ⚠️ The Plan is a LAZY chunk: on
 *  a loaded machine its first import outlasts any fixed settle, and a second ⌘] pressed before
 *  the board is up steps straight past the plans — so each step waits for the board itself. */
export const openPlan = async (planId: string) => {
  for (let i = 0; i < 8 && !(mode() === 'plans' && lastBoard()?.activeId === planId); i++) {
    key(']', { metaKey: true }); await settle()
    if (mode() === 'plans') await waitFor(() => expect(screen.getByTestId('whiteboard')).toBeTruthy(), { timeout: 10_000 })
  }
  expect(mode()).toBe('plans')
  expect(lastBoard()?.activeId).toBe(planId)
}
export const boardIds = () => (lastBoard()?.annos ?? []).map((a) => a.id)
