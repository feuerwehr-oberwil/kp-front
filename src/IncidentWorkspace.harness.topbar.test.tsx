// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentType, type ReactNode } from 'react'
import type { AttendanceState, BoardAnno, MittelEntry } from './types'
import { AUTH, SYM, rec, registerHarnessHooks, meta, truck, workspaceTree, settle, key, mode, openPlan, lastBoard } from './IncidentWorkspace.harness.setup'
import type { Saved } from './lib/workspace'
import { WorkspaceSync } from './lib/api/workspaceSync'
import { applyLocale, getCopy } from './config/copy'

/*
 * The workspace harness (shared setup: IncidentWorkspace.harness.setup.tsx) — the top bar group
 * (performance sweep 26.11.2026):
 *
 *   (t) WorkspaceTopBar, TopBar, the IncidentSwitcher and the SharePositionPill render only when
 *       what they show changed: not for a workspace commit elsewhere (a Tafel drag, a pull, a
 *       composer key), and per tap only the parts the tap changed (↶ ↷ in TopBar, the sync state
 *       in the switcher).
 *   (u) …and they still follow their data at once: a handler reads the latest values, a rename
 *       and a new Einsatz reach the switcher, the sync state its pill, a late language catalogue
 *       every part, a read-only surface the ↶ ↷ pair.
 *
 * Each part is `memo` (workspace/WorkspaceTopBar). The counter goes INSIDE the memo – it wraps the
 * memo's own render function – so a count is a render the memo let through.
 */

const n = vi.hoisted(() => ({} as Record<string, number>))
/** the memo `Real` again, with a counter in its render; a part that is not `memo` counts every
 *  parent render, as the parts did before the sweep. Only a render with NEW props counts: the
 *  part's own state (the switcher's timers) renders it with the props it had, and that is not
 *  what a parent hands it. */
function counted<P extends object>(name: string, Real: ComponentType<P>) {
  const inner = (Real as unknown as { type?: (p: P) => ReactNode }).type
  if (!inner) return function Counted(p: P) { n[name] = (n[name] ?? 0) + 1; return <Real {...p} /> }
  const seen = new WeakSet<object>()
  return { ...Real, type: (p: P) => {
    if (!seen.has(p)) { seen.add(p); n[name] = (n[name] ?? 0) + 1 }
    return inner(p)
  } } as unknown as ComponentType<P>
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
  return { ...mod, confirmDialog: () => { rec.confirms++; return Promise.resolve(rec.answers.shift() ?? rec.answer) } }
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
const none: Counts = { WorkspaceTopBar: 0, TopBar: 0, IncidentSwitcher: 0, SharePositionPill: 0 }
/** a tap: two workspace commits change what the bar shows – the first ↶ ↷ and the sync state,
 *  the second the sync state again. The switcher is TopBar's title slot, so a commit that
 *  changes it renders TopBar too. The pill shows neither. */
const TAP: Counts = { WorkspaceTopBar: 2, TopBar: 2, IncidentSwitcher: 2, SharePositionPill: 0 }
/** a switch: the bar and the switcher once, for the surface (navKey) */
const SWITCH: Counts = { WorkspaceTopBar: 1, TopBar: 1, IncidentSwitcher: 1, SharePositionPill: 0 }

const open = async () => {
  const m = meta()
  const sync = new WorkspaceSync(m.id)
  const save = vi.spyOn(sync, 'save')
  const ws = { entities: [truck], trupps: [crew], attendance } as unknown as Saved
  const { tree } = workspaceTree(m, { sync, workspace: ws })
  const utils = render(tree)
  await settle()
  /** the workspace again, with other props from its parent (App) */
  const rerender = async (over: Parameters<typeof workspaceTree>[1]) => { utils.rerender(workspaceTree(m, { sync, workspace: ws, ...over }).tree); await settle() }
  return { m, sync, save, rerender }
}
const tapGast03 = async () => { fireEvent.click(screen.getAllByRole('button', { name: /Gast 03$/ })[0]); await settle(200) }
const counts = () => document.body.textContent ?? ''
/** the one element `sel` names – a missing one fails the test there */
const one = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`no ${sel}`)
  return el
}
const switcher = () => one<HTMLButtonElement>('.ip-switch-btn')

describe('(t) the top bar group per act', () => {
  it('one Anwesenheit tap: the bar for ↶ ↷ and the sync state, the pill not', async () => {
    await open()
    key('p'); await settle(200)
    expect(mode()).toBe('anwesenheit')
    const before = snapshot()
    await tapGast03()
    expect(counts()).toMatch(/(?<!\d)8 anwesend · 5 gegangen/)
    expect(since(before)).toEqual(TAP)
  })

  it('one «Kontakt» on the Trupps: the same', async () => {
    await open()
    key('a'); await settle()
    expect(mode()).toBe('atemschutz')
    const before = snapshot()
    fireEvent.click(screen.getAllByRole('button', { name: /Kontakt/ })[0])
    await settle(200)
    expect(since(before)).toEqual(TAP)
  })

  it('ten keystrokes in the composer: nothing', async () => {
    await open()
    key('e'); await settle(100)
    const box = one<HTMLTextAreaElement>('.journal-composer textarea')
    const before = snapshot()
    for (let i = 1; i <= 10; i++) { fireEvent.change(box, { target: { value: 'Brand'.slice(0, i) + 'x'.repeat(Math.max(0, i - 5)) } }); await settle(5) }
    expect(box.value).toBe('Brandxxxxx')
    expect(since(before)).toEqual(none)
  })

  it('a surface switch: the bar and the switcher once, the pill not', async () => {
    await open()
    const before = snapshot()
    key('a'); await settle(100)
    expect(mode()).toBe('atemschutz')
    expect(since(before)).toEqual(SWITCH)
  })

  it('a 40-move drag on the Tafel: nothing', async () => {
    await open()
    await openPlan('tafel')
    const doc = rec.boardDoc as unknown as { commit: (next: BoardAnno[]) => void; pushPast: () => void; patch: (id: string, p: Partial<BoardAnno>) => void }
    act(() => { doc.commit([...(lastBoard()?.annos ?? []), { id: 'n1', kind: 'text', x: 0.5, y: 0.5, floor: 0, text: 'n1' } as BoardAnno]) })
    await settle()
    const before = snapshot()
    act(() => { doc.pushPast() })
    for (let i = 0; i < 40; i++) act(() => { doc.patch('n1', { x: 0.5 + i / 200 }) })
    await settle()
    expect(since(before)).toEqual(none)
  })

  it('a pull that changed one Trupp: nothing', async () => {
    const { sync, save } = await open()
    await settle(60)
    const held = save.mock.lastCall?.[0] as Saved
    expect(held).toBeDefined()
    const before = snapshot()
    act(() => { sync.onApplyMerged?.({ ...held, trupps: (held.trupps ?? []).map((t) => ({ ...t, entryPressureBar: 280 })) } as never, 1) })
    await settle(60)
    expect(since(before)).toEqual(none)
  })
})

describe('(u) the top bar still follows its data', () => {
  it('↶ after a tap takes THAT tap back – the steady handler reads the latest history', async () => {
    await open()
    key('p'); await settle(200)
    expect(counts()).toMatch(/(?<!\d)9 anwesend · 4 gegangen/)
    await tapGast03()
    expect(counts()).toMatch(/(?<!\d)8 anwesend · 5 gegangen/)
    fireEvent.click(one('.tb-act-history:not(.tb-act-redo)'))
    await settle(200)
    expect(counts()).toMatch(/(?<!\d)9 anwesend · 4 gegangen/)
  })

  it('a rename and a new Einsatz from App reach the switcher', async () => {
    const { m, rerender } = await open()
    // the pill names the Einsatz by its address while it has no Stichwort (lib/format · einsatzHeadName)
    const renamed = { ...m, address: 'Neugasse 5', title: 'Umbenannt' }
    const other = { ...meta(), title: 'Zweiter Einsatz' }
    await rerender({ incidentMeta: renamed, incidents: [renamed, other] })
    expect(switcher().textContent).toContain('Neugasse 5')
    expect(switcher().getAttribute('aria-label')).toContain('Umbenannt')
    fireEvent.click(switcher()); await settle()
    expect(counts()).toContain('Zweiter Einsatz')
  })

  it('the switcher shows the sync state of each commit', async () => {
    await open()
    key('p'); await settle(200)
    const seen: (string | undefined)[] = []
    const watch = new MutationObserver(() => { seen.push(switcher().dataset.sync) })
    watch.observe(switcher(), { attributes: true, attributeFilter: ['data-sync'] })
    await tapGast03()
    watch.disconnect()
    expect(seen).toContain('pending')
  })

  it('a language catalogue that lands late reaches the bar, the switcher and their words', async () => {
    await open()
    const verlauf = () => one('.topbar .tb-act[aria-expanded]')
    const de = getCopy().journal.open
    expect(verlauf().getAttribute('aria-label')).toBe(de)
    try {
      await act(async () => { await applyLocale('en') })
      expect(getCopy().journal.open).not.toBe(de)
      expect(verlauf().getAttribute('aria-label')).toBe(getCopy().journal.open)
      expect(switcher().getAttribute('aria-label')).toContain(getCopy().exerciseBadge)
    } finally {
      await act(async () => { await applyLocale('de-CH') })
    }
  })

  it('the page that becomes the installed app (Chromium moves the tab) drops «Als App installieren»', async () => {
    let standalone = false
    const changed = new Set<() => void>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(display-mode: standalone)' && standalone },
      media: query, onchange: null,
      addEventListener: (_: string, l: () => void) => { changed.add(l) },
      removeEventListener: (_: string, l: () => void) => { changed.delete(l) },
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }))
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36')
    try {
      await open()
      const row = () => screen.queryByText(getCopy().install.menu)
      fireEvent.click(switcher()); await settle()
      expect(row()).toBeTruthy()
      act(() => { standalone = true; changed.forEach((l) => l()) })
      expect(row()).toBeNull()
    } finally { ua.mockRestore() }
  })

  it('a surface that turns read-only takes the ↶ ↷ pair away', async () => {
    const { rerender } = await open()
    expect(document.querySelector('.tb-act-history')).toBeTruthy()
    await rerender({ forceReadOnly: true })
    expect(document.querySelector('.tb-act-history')).toBeNull()
  })
})
