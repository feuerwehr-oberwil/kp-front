// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { Entity, MittelEntry } from './types'
import type { MittelDraft } from './components/MittelView'
import { AUTH, SYM, rec, registerHarnessHooks, lastMap, lastBoard, meta, truck, workspaceTree, settle, mount, lastBtn, key, openPlan, type BoardProps } from './IncidentWorkspace.harness.setup'
import { Meldeleiste } from './components/Meldeleiste'
import { WorkspaceSync } from './lib/api/workspaceSync'
import type { Saved } from './lib/workspace'
import { appConfig } from './config/appConfig'
import { loadPrefs, savePrefs } from './lib/prefs'
import { fillTemplate } from './lib/format'

/*
 * The workspace harness (shared setup: IncidentWorkspace.harness.setup.tsx) — what the workspace
 * writes:
 *
 *   (e) the two-device loop: a merge that changes nothing must write nothing back; and acts on the
 *       picture say what they did.
 *   (f) a merge reaches the screen: what another device wrote shows here, and this device's next
 *       save carries it — a slice the merge never handed to its setter is saved back as a delete;
 *       Gäste from the Trupp form reach the Anwesenheit once, as ONE undo step (f2).
 *   (g) a Link-registered crew reaches the Anwesenheit through the editor device.
 *   (m) a read-only session writes nothing.
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

// 3am test r3, 25.09.2026: acts the Verlauf used to miss
describe('(e) acts on the picture say what they did — on the ↶ and in the Verlauf', () => {
  const rows = async () => { key('r'); await settle(60); return (rec.report?.events ?? []).map((e) => e.text) }

  // its Verlauf row comes with #226; no toast since the Gebäude round 2 (27.10.2026)
  it('«+ OG» names the storey on its ↶, without a toast', async () => {
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
    const line = fillTemplate(appConfig.copy.whiteboard.floorAddedStep, { floor: '3. OG' })
    const undoBtn = screen.getAllByRole('button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Rückgängig:'))
    expect(undoBtn?.getAttribute('aria-label')).toContain(line)
    // the new tile is the confirmation: nothing else on screen says it
    expect(screen.queryByText(line)).toBeNull()
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

/* RBAC audit 22.10.2026 (§2): a session that cannot write the Einsatz is handed no door that
   changes this device's picture of it – nothing it took could ever sync. */
describe('(m) a read-only session writes nothing', () => {
  /** a Trupp whose Funkkontakt runs past interval + Nachfrist (5 min + 60 s) under the test's
   *  eyes – the engine records a crossing it WATCHED, not an alarm it found on mount */
  const crossingWs = () => {
    const entry = new Date(Date.now() - 20 * 60_000).toISOString()
    const contact = new Date(Date.now() - 360_000 + 700).toISOString()
    return { entities: [truck], trupps: [{ id: 'tr-v', name: 'Tst Vera', status: 'aktiv', entryPressureBar: 300, entryTime: entry, lastContactTime: contact }] } as unknown as Saved
  }
  const rows = () => [...document.querySelectorAll('.ml-row')].map((r) => r.textContent ?? '')

  // V1: the alarm engine logged its rows on every viewer – kept locally, never sent, and the
  // read-only store flipped the badge to a red «Speicher voll» on the Fahrer tablet mid-alarm
  it('a viewer\'s alarm rings, but writes no Verlauf row and raises no «Speicher voll»', async () => {
    AUTH.role = 'viewer'
    const m = meta()
    render(<><Meldeleiste />{workspaceTree(m, { sync: new WorkspaceSync(m.id), workspace: crossingWs() }).tree}</>)
    await settle(60); await settle(1_100); await settle(1_100) // the 1 Hz tick crosses
    expect(rows().some((t) => t.includes('Tst Vera'))).toBe(true) // the alarm is on
    expect(rows().some((t) => t.includes(appConfig.copy.incidentSwitcher.storageMeldung))).toBe(false)
    key('r'); await settle()
    expect((rec.report?.events ?? []).some((e) => e.text?.includes('Tst Vera'))).toBe(false)
  })

  // V1: the el may not write the Trupps, so it does not record their alarm either – the device
  // that keeps the Tafel (FU, Atemschutz-Link) writes that row, once per turnus
  it('the el\'s alarm rings, but posts no «Atemschutz-Alarm» row', async () => {
    AUTH.role = 'el'
    const posted: { text?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/journal') && init?.method === 'POST') {
        posted.push(...(JSON.parse(String(init.body)) as { entries: { text?: string }[] }).entries)
        return new Response(JSON.stringify({ entries: [], latest_seq: 0 }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }))
    const m = meta()
    render(<><Meldeleiste />{workspaceTree(m, { sync: new WorkspaceSync(m.id), workspace: crossingWs() }).tree}</>)
    await settle(60); await settle(1_100); await settle(1_100); await settle(2_600) // the crossing, then the outbox's round
    expect(rows().some((t) => t.includes('Tst Vera'))).toBe(true)
    const alarmRow = appConfig.copy.atemschutz.logAlarm.split('{')[0] // «Atemschutz-Alarm: Trupp »
    expect(posted.some((r) => r.text?.startsWith(alarmRow))).toBe(false)
  }, 15_000)

  // V4: the checklist's «Verlauf» deep link opened the composer past every other gate
  it('a viewer\'s checklist «Verlauf» opens the Verlauf, never the composer', async () => {
    AUTH.role = 'viewer'
    await mount()
    key('c'); await settle()
    // the item's own deep link – the TopBar's «Verlauf» carries the same name
    let row: HTMLElement | null = screen.getByText('Protokoll / Journal vorbereiten')
    while (row && !row.querySelector(`button[title="${appConfig.copy.checklists.actionLabels.journal}"]`)) row = row.parentElement
    fireEvent.click(row!.querySelector(`button[title="${appConfig.copy.checklists.actionLabels.journal}"]`)!)
    await settle()
    expect(document.querySelector('.journal-composer')).toBeNull()
    expect(document.querySelector('.journal-drawer')).toBeTruthy()
  })

  // V5: «Anderes Objekt wählen» switched the plans on this device only (the next editor save
  // flipped them back) – a locked session keeps the object chip as a read-out
  it('a viewer\'s Plan offers no object switch', async () => {
    AUTH.role = 'viewer'
    await mount()
    await openPlan('tafel')
    expect(lastBoard()?.onObjectSwitch).toBeUndefined()
    await settle(100)
  })
})
