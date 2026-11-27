// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentType } from 'react'
import type { AttendanceState, MittelEntry } from './types'
import { AUTH, SYM, rec, registerHarnessHooks, meta, truck, workspaceTree, settle, key, mode } from './IncidentWorkspace.harness.setup'
import type { Saved } from './lib/workspace'
import { WorkspaceSync } from './lib/api/workspaceSync'

/*
 * The workspace harness (shared setup: IncidentWorkspace.harness.setup.tsx) — what the top bar
 * group costs per act (performance sweep 26.11.2026, finding 34: the React Compiler trial):
 *
 *   (t) renders of WorkspaceTopBar, TopBar and the parts they render from their own files, for one
 *       Anwesenheit tap, one «Kontakt» and ten composer keystrokes.
 *
 * Each part is wrapped in a counter that renders the real component, so a count is the number of
 * wrapper invocations – what a memoising parent (or the compiler) can bring down. The numbers are
 * the same with the compiler off, on the top bar group alone, and on the components and the
 * workspace (`REACT_COMPILER` in vite.config.ts): IncidentWorkspace is not compiled and hands the
 * bar new props on every render; the compiled WorkspaceTopBar caches its children's elements only
 * while their inputs stay the same, and some do not (e.g. the `onShareChangeName` callback the
 * workspace recreates on every render).
 */

const n = vi.hoisted(() => ({} as Record<string, number>))
/** a stand-in that counts its renders and renders the real `Real` */
function counted<P extends object>(name: string, Real: ComponentType<P>) {
  return function Counted(p: P) { n[name] = (n[name] ?? 0) + 1; return <Real {...p} /> }
}
vi.mock('./workspace/WorkspaceTopBar', async (importOriginal) => {
  const m = await importOriginal<typeof import('./workspace/WorkspaceTopBar')>()
  return { ...m, WorkspaceTopBar: counted('WorkspaceTopBar', m.WorkspaceTopBar) }
})
vi.mock('./components/TopBar', async (importOriginal) => {
  const m = await importOriginal<typeof import('./components/TopBar')>()
  return { ...m, TopBar: counted('TopBar', m.TopBar) }
})
vi.mock('./components/panels', async (importOriginal) => {
  const m = await importOriginal<typeof import('./components/panels')>()
  return { ...m, IncidentSwitcher: counted('IncidentSwitcher', m.IncidentSwitcher) }
})
vi.mock('./components/SharePosition', async (importOriginal) => {
  const m = await importOriginal<typeof import('./components/SharePosition')>()
  return { ...m, SharePositionPill: counted('SharePositionPill', m.SharePositionPill) }
})

// ── the harness stand-ins, verbatim from IncidentWorkspace.harness.hiddenmap.test.tsx ──
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
vi.mock('./components/MittelView', () => ({
  MittelView: (p: Record<string, unknown> & { entries: MittelEntry[] }) => {
    rec.mittel.push(p)
    return <ul data-testid="mittel">{p.entries.map((e) => <li key={e.id}>{e.label}</li>)}</ul>
  },
}))
vi.mock('./components/ReportPreflight', () => ({
  ReportPreflight: (p: { events: { text?: string }[] }) => { rec.report = p; return null },
  requestReportStep: () => {},
}))
vi.mock('./lib/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/ui')>()
  return { ...mod, confirmDialog: () => { rec.confirms++; return Promise.resolve(rec.answers.length ? rec.answers.shift()! : rec.answer) } }
})
vi.mock('./lib/reportError', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/reportError')>()),
  reportClientError: (err: unknown, ctx: { kind?: string; surface?: string } = {}) => {
    rec.reported.push(`${ctx.kind ?? '?'}${ctx.surface ? `(${ctx.surface})` : ''}: ${err instanceof Error ? err.message : String(err)}`)
  },
}))

registerHarnessHooks()

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const crew = { id: 'tr-a', no: 1, name: 'Tst Anna', status: 'aktiv', entryPressureBar: 300, entryTime: ago(5), lastContactTime: ago(4) }
/** twelve people recorded for this Einsatz only (the harness has no roster): eight present, four
 *  gone – plus the Trupp's crew, which the workspace files as present */
const attendance: AttendanceState = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`g${i}`, {
  status: i < 8 ? 'present' : 'left', displayNameSnapshot: `Gast ${String(i).padStart(2, '0')}`,
  checkedInAt: ago(30), ...(i < 8 ? {} : { leftAt: ago(10) }),
}]))

const PARTS = ['WorkspaceTopBar', 'TopBar', 'IncidentSwitcher', 'SharePositionPill'] as const
type Counts = Record<(typeof PARTS)[number], number>
const snapshot = (): Counts => Object.fromEntries(PARTS.map((k) => [k, n[k] ?? 0])) as Counts
const since = (before: Counts): Counts => Object.fromEntries(PARTS.map((k) => [k, (n[k] ?? 0) - before[k]])) as Counts

/** what one workspace act costs the bar today: two workspace renders, each renders the whole bar */
const twice: Counts = { WorkspaceTopBar: 2, TopBar: 2, IncidentSwitcher: 2, SharePositionPill: 2 }

const open = async () => {
  const m = meta()
  const { tree } = workspaceTree(m, { sync: new WorkspaceSync(m.id), workspace: { entities: [truck], trupps: [crew], attendance } as unknown as Saved })
  render(tree)
  await settle()
}

describe('(t) the top bar group per act', () => {
  it('one Anwesenheit tap', async () => {
    await open()
    key('p'); await settle(200)
    expect(mode()).toBe('anwesenheit')
    const before = snapshot()
    fireEvent.click(screen.getAllByRole('button', { name: /Gast 03$/ })[0])
    await settle(200)
    expect(document.body.textContent ?? '').toMatch(/(?<!\d)8 anwesend · 5 gegangen/)
    expect(since(before)).toEqual(twice)
  })

  it('one «Kontakt» on the Trupps', async () => {
    await open()
    key('a'); await settle()
    expect(mode()).toBe('atemschutz')
    const before = snapshot()
    fireEvent.click(screen.getAllByRole('button', { name: /Kontakt/ })[0])
    await settle(200)
    expect(since(before)).toEqual(twice)
  })

  it('ten keystrokes in the composer', async () => {
    await open()
    key('e'); await settle(100)
    const box = document.querySelector<HTMLTextAreaElement>('.journal-composer textarea')!
    expect(box).toBeTruthy()
    const before = snapshot()
    for (let i = 1; i <= 10; i++) { fireEvent.change(box, { target: { value: 'Brand'.slice(0, i) + 'x'.repeat(Math.max(0, i - 5)) } }); await settle(5) }
    expect(box.value).toBe('Brandxxxxx')
    expect(since(before)).toEqual({ WorkspaceTopBar: 0, TopBar: 0, IncidentSwitcher: 0, SharePositionPill: 0 })
  })
})
