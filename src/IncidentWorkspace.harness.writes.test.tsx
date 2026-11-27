// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import type { Entity, MittelEntry, ReportAttachment } from './types'
import type { ReportSignature } from './lib/reportSignature'
import type { MittelDraft } from './components/MittelView'
import { AUTH, SYM, rec, registerHarnessHooks, lastMap, lastBoard, meta, truck, workspaceTree, settle, mount, lastBtn, key, openPlan, type BoardProps, type WsProps } from './IncidentWorkspace.harness.setup'
import { Meldeleiste } from './components/Meldeleiste'
import { WorkspaceSync } from './lib/api/workspaceSync'
import { AuditEventStore } from './lib/auditEventStore'
import { JournalStore } from './lib/journalStore'
import type { Saved } from './lib/workspace'
import type { IncidentMeta } from './lib/api/incidents'
import type { IncidentPlanBinding } from './lib/incidentPlanBindings'
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

// a Beilage's preparation (thumbnail, resized bytes) settles at once: jsdom decodes no image
vi.mock('./lib/imagePrep', async (importOriginal) => ({ ...(await importOriginal<typeof import('./lib/imagePrep')>()), prepareUploadImage: (f: Blob) => Promise.resolve(f) }))
vi.mock('./lib/mediaUrl', async (importOriginal) => ({ ...(await importOriginal<typeof import('./lib/mediaUrl')>()), mintLocalThumb: () => Promise.resolve() }))

/** the plan resolver's doors (useObjectPlans): a binding it fetched (`onBind`) — the test calls it
 *  where the resolver's fetch would land — and the operator's object pick (`onPick`) */
const boundPlans = vi.hoisted(() => ({
  onBind: undefined as ((proposed: IncidentPlanBinding[]) => void) | undefined,
  onPick: undefined as ((objectId: string | undefined) => void) | undefined,
}))
vi.mock('./lib/useObjectPlans', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/useObjectPlans')>()
  return {
    ...mod,
    useObjectPlans: (...a: Parameters<typeof mod.useObjectPlans>) => {
      boundPlans.onPick = a[4]; boundPlans.onBind = a[5]?.onBind
      return mod.useObjectPlans(...a)
    },
  }
})
const binding: IncidentPlanBinding = {
  id: 'obj1:modul2', objectId: 'obj1', planId: 'modul2', datasetId: 'ds1', planVersion: 1, page: 0, title: 'EG', georef: { pairs: [] }, source: 'none',
}

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

describe('(f) a pull moves only what it changed', () => {
  // Perf sweep 26.11.2026 #26: a pull handed every slice to its setter with a fresh value, so one
  // Trupp saved elsewhere re-rendered every memo, re-serialized the blob and rewrote the Ebenen.
  // Now an unchanged record keeps its identity, and a pull that changed nothing writes nothing.
  const tr = (id: string, no: number, name: string) => ({ id, no, name, members: [], entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', readings: [] })
  const other = { ...truck, id: 'p2', coord: [7.61, 47.51] } as Entity
  type Blob = Parameters<NonNullable<WorkspaceSync['onApplyMerged']>>[0]
  /** the save effect's serialization of the whole blob — the only stringify of a `Saved` */
  const isBlob = (v: unknown) => !!v && typeof v === 'object' && 'schemaVersion' in v && 'objects' in v
  /** a device on an Einsatz with two Trupps and two Karte objects, settled — `held` is the blob
   *  as it holds it now (its boot already filed the crews: a pull of the boot blob is a change) */
  const device = async () => {
    const m = meta()
    const sync = new WorkspaceSync(m.id)
    const save = vi.spyOn(sync, 'save')
    const { tree } = workspaceTree(m, { sync, workspace: { entities: [truck, other], trupps: [tr('t1', 1, 'Tst Ida'), tr('t2', 2, 'Tst Jan')] } as unknown as Saved })
    render(tree)
    await settle(60); await settle(60)
    const held = save.mock.lastCall![0] as Saved
    save.mockClear()
    return { sync, save, held }
  }
  const pullCost = async (sync: WorkspaceSync, blob: Blob) => {
    const before = lastMap()
    const stringify = vi.spyOn(JSON, 'stringify')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    act(() => { sync.onApplyMerged!(blob, 1) })
    await settle(60)
    const after = lastMap()
    const cost = {
      keptEntities: after.entities.filter((e) => before.entities.includes(e)).length,
      keptLayers: after.layers === before.layers,
      serializations: stringify.mock.calls.filter(([v]) => isBlob(v)).length,
      layerWrites: setItem.mock.calls.filter(([k]) => String(k).startsWith('kp.layers.')).length,
    }
    stringify.mockRestore(); setItem.mockRestore()
    return cost
  }
  /** another device's save that changed one thing on one Trupp (its entry pressure) */
  const oneTrupp = (held: Saved) =>
    ({ ...held, trupps: held.trupps!.map((t) => (t.id === 't2' ? { ...t, entryPressureBar: 280 } : t)) }) as unknown as Blob

  it('one Trupp changed elsewhere: every Karte object and the Ebenen keep their identity', async () => {
    const { sync, held } = await device()
    expect(await pullCost(sync, oneTrupp(held))).toEqual({ keptEntities: 2, keptLayers: true, serializations: 1, layerWrites: 0 })
  })

  it('a pull that changed nothing serializes nothing and writes no Ebenen', async () => {
    const { sync, held } = await device()
    expect(await pullCost(sync, held as unknown as Blob)).toEqual({ keptEntities: 2, keptLayers: true, serializations: 0, layerWrites: 0 })
  })

  it('a remote delete, a reorder and a change inside a record each reach the follower', async () => {
    const { sync, held } = await device()
    const objs = held.objects!
    const pull = (objects: typeof objs, rev: number) => { act(() => { sync.onApplyMerged!({ ...held, objects } as unknown as Blob, rev) }) }
    pull([objs[1], objs[0]], 1)
    await settle(60)
    expect(lastMap().entities.map((e) => e.id)).toEqual(['p2', 'p1'])
    pull([objs[1], { ...objs[0], entity: { ...objs[0].entity!, coord: [7.7, 47.6] } }], 2)
    await settle(60)
    expect(lastMap().entities.find((e) => e.id === 'p1')?.coord).toEqual([7.7, 47.6])
    pull([objs[1]], 3)
    await settle(60)
    expect(lastMap().entities.map((e) => e.id)).toEqual(['p2'])
  })

  // ⚠️ the echo guard (useIncidentSync · hydrate): only the save effect spends it, and a pull that
  // moved nothing runs no save effect — the guard left standing swallowed the next local edit
  it('a local edit right after a pull that changed nothing is saved', async () => {
    const { sync, save, held } = await device()
    act(() => { sync.onApplyMerged!(held as unknown as Blob, 1) })
    await settle(60)
    expect(save).not.toHaveBeenCalled()
    act(() => { lastMap().onSelect(lastMap().entities[0]) })
    act(() => { key('Delete') })
    await settle(60)
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.lastCall![0] as Saved).objects?.map((o) => o.id)).toEqual(['p2'])
  })

  it('a pull that only brought older Verlauf rows is not saved back, and the local edit after it is', async () => {
    const { sync, save, held } = await device()
    const rows = [{ id: 'legacy-1', t: '10:05', icon: 'note', text: 'Lage erkundet' }]
    act(() => { sync.onApplyMerged!({ ...held, timeline: rows } as unknown as Blob, 1) })
    await settle(60)
    expect(save).not.toHaveBeenCalled()
    act(() => { lastMap().onSelect(lastMap().entities[0]) })
    act(() => { key('Delete') })
    await settle(60)
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.lastCall![0] as Saved).objects?.map((o) => o.id)).toEqual(['p2'])
  })

  it('two pulls in one batch that end where they started: the local edit after them is saved', async () => {
    const { sync, save, held } = await device()
    act(() => {
      sync.onApplyMerged!({ ...held, intakeReviewedAt: '2026-09-23T10:30:00Z' } as unknown as Blob, 1)
      sync.onApplyMerged!(held as unknown as Blob, 2)
    })
    await settle(60)
    expect(save).not.toHaveBeenCalled()
    act(() => { lastMap().onSelect(lastMap().entities[0]) })
    act(() => { key('Delete') })
    await settle(60)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a pull that changed one Trupp is not saved back, and the local edit after it is', async () => {
    const { sync, save, held } = await device()
    act(() => { sync.onApplyMerged!(oneTrupp(held), 1) })
    await settle(60)
    expect(save).not.toHaveBeenCalled()
    act(() => { lastMap().onSelect(lastMap().entities[0]) })
    act(() => { key('Delete') })
    await settle(60)
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.lastCall![0] as Saved
    expect(saved.objects?.map((o) => o.id)).toEqual(['p2'])
    expect(saved.trupps?.map((t) => t.entryPressureBar)).toEqual([300, 280])
  })
  // ⚠️ the echo guard skips a save only when the blob is built from nothing but what pulls handed
  // in (useWorkspaceBlob · pulled). A write made before the pull's render — a tap folded into the
  // live store that already holds the pull, an async write landing — renders with it and is saved.
  it('a marker deleted before the pull that moved another one and a Trupp has rendered: all of it is saved', async () => {
    const { sync, save, held } = await device()
    const objs = held.objects!
    const moved = { ...oneTrupp(held), objects: objs.map((o) => (o.id === 'p2' ? { ...o, entity: { ...o.entity!, coord: [7.7, 47.6] } } : o)) } as unknown as Blob
    act(() => { lastMap().onSelect(lastMap().entities.find((e) => e.id === 'p1')!) })
    act(() => {
      sync.onApplyMerged!(moved, 1) // queued, not yet rendered
      key('Delete') // a discrete event: React 19 renders it together with the pull
    })
    await settle(60)
    expect(lastMap().entities.map((e) => e.id)).toEqual(['p2'])
    expect(save).toHaveBeenCalled()
    const saved = save.mock.lastCall![0] as Saved
    expect(saved.objects?.map((o) => o.id)).toEqual(['p2'])
    expect(saved.objects?.[0].entity?.coord).toEqual([7.7, 47.6])
    expect(saved.trupps?.map((t) => t.entryPressureBar)).toEqual([300, 280])
  })

  it('a pick back to the object the save last built, in the pull\'s render, is saved', async () => {
    const { sync, save, held } = await device()
    expect(held.pickedObjectId).toBeUndefined()
    act(() => {
      sync.onApplyMerged!({ ...oneTrupp(held), pickedObjectId: 'obj2' } as unknown as Blob, 1)
      boundPlans.onPick!(undefined) // «Automatisch» again: the value this device last saved
    })
    await settle(60)
    expect(save).toHaveBeenCalled()
    const saved = save.mock.lastCall![0] as Saved
    expect(saved.pickedObjectId).toBeUndefined()
    expect(saved.trupps?.map((t) => t.entryPressureBar)).toEqual([300, 280])
  })

  it('a plan binding that lands in the pull\'s render is saved, the pulled Trupp with it', async () => {
    const { sync, save, held } = await device()
    act(() => {
      sync.onApplyMerged!(oneTrupp(held), 1)
      boundPlans.onBind!([binding])
    })
    await settle(60)
    expect(save).toHaveBeenCalled()
    const saved = save.mock.lastCall![0] as Saved
    expect(saved.planBindings?.map((b) => b.id)).toEqual([binding.id])
    expect(saved.trupps?.map((t) => t.entryPressureBar)).toEqual([300, 280])
  })
})

// Perf sweep 27.11.2026, case (b): a signature (or a Beilage) appended just before a pull's
// continuation ran was queued first, and the pull's plain replacement of the list behind it wiped
// it — the Verlauf said «unterschrieben», the Rapport showed no signature, and no later save
// carried it. Now the pull merges into what React queued (lib/workspace · applyInitialState).
describe('(f) a signature or a Beilage queued before a pull stays', () => {
  type Blob = Parameters<NonNullable<WorkspaceSync['onApplyMerged']>>[0]
  type Report = { reportSignatures: ReportSignature[]; attachments: ReportAttachment[]; onSign: (s: ReportSignature) => void; onAddAttachments: (f: File[]) => void }
  const report = () => rec.report as unknown as Report
  const sig = (id: string, role: ReportSignature['role']): ReportSignature =>
    ({ id, role, name: `${role} Test`, at: '2026-11-27T10:00:00Z', scope: 'a'.repeat(64), strokes: { w: 10, h: 10, d: [[0, 0, 1, 1]] } })
  const att = (id: string): ReportAttachment => ({ id, url: `/api/media/${id}`, at: '2026-11-27T09:00:00Z' })
  /** an editor on the Rapport, settled — `held` is the blob as this device saved it at boot */
  const device = async (ws: Partial<Saved> = {}) => {
    const m = meta()
    const sync = new WorkspaceSync(m.id)
    const save = vi.spyOn(sync, 'save')
    const trupps = [{ id: 't1', no: 1, name: 'Tst Ida', members: [], entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', readings: [] }]
    const { tree } = workspaceTree(m, { sync, workspace: { entities: [truck], trupps, ...ws } as unknown as Saved })
    render(tree)
    await settle(60); await settle(60)
    key('r'); await settle(60)
    const held = save.mock.lastCall![0] as Saved
    save.mockClear()
    return { sync, save, held }
  }
  const ids = (list: readonly { id: string }[] | undefined) => (list ?? []).map((r) => r.id)
  /** a Beilage added here, its preparation settled and its row queued — the pull lands after it,
   *  before React renders either */
  const addThenPull = async (sync: WorkspaceSync, blob: Blob) => {
    const emitted = vi.spyOn(AuditEventStore.prototype, 'append')
    await act(async () => {
      report().onAddAttachments([new File(['x'], 'b.jpg', { type: 'image/jpeg' })])
      const queued = () => emitted.mock.calls.some(([e]) => e.op_type === 'report.attachment.add')
      for (let i = 0; i < 50 && !queued(); i++) await Promise.resolve()
      expect(queued()).toBe(true)
      sync.onApplyMerged!(blob, 1)
    })
    emitted.mockRestore()
    await settle(60)
  }

  it('Kdt signs while a pull brings the EL\'s signature: both show, and both are saved', async () => {
    const { sync, save, held } = await device()
    act(() => {
      report().onSign(sig('s-kdt', 'kdt')) // queued, not yet rendered
      sync.onApplyMerged!({ ...held, reportSignatures: [sig('s-el', 'el')] } as unknown as Blob, 1)
    })
    await settle(60)
    expect(ids(report().reportSignatures)).toEqual(['s-el', 's-kdt'])
    expect(save).toHaveBeenCalled()
    expect(ids((save.mock.lastCall![0] as Saved).reportSignatures)).toEqual(['s-el', 's-kdt'])
  })

  it('the pull already holds this device\'s signature: it shows once, and nothing is saved back', async () => {
    const { sync, save, held } = await device()
    const mine = sig('s-kdt', 'kdt')
    act(() => {
      report().onSign(mine)
      sync.onApplyMerged!({ ...held, reportSignatures: [mine] } as unknown as Blob, 1)
    })
    await settle(60)
    expect(ids(report().reportSignatures)).toEqual(['s-kdt'])
    expect(save).not.toHaveBeenCalled()
  })

  it('a pull that changes the signatures with nothing queued is applied as it came, not saved back', async () => {
    const { sync, save, held } = await device({ reportSignatures: [sig('s-el', 'el')] })
    const pulled = [{ ...sig('s-el', 'el'), voidedAt: '2026-11-27T10:05:00Z' }, sig('s-el2', 'el')]
    act(() => { sync.onApplyMerged!({ ...held, reportSignatures: pulled } as unknown as Blob, 1) })
    await settle(60)
    expect(report().reportSignatures).toEqual(pulled)
    expect(save).not.toHaveBeenCalled()
  })

  it('a Beilage added while a pull brings another device\'s: both show, and both are saved', async () => {
    const { sync, save, held } = await device()
    await addThenPull(sync, { ...held, attachments: [att('a-theirs')] } as unknown as Blob)
    const shown = ids(report().attachments)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toBe('a-theirs')
    expect(ids((save.mock.lastCall![0] as Saved).attachments)).toEqual(shown)
  })

  it('a Beilage another device removed goes here too — with or without a Beilage queued here', async () => {
    const { sync, save, held } = await device({ attachments: [att('a1'), att('a2')] })
    act(() => { sync.onApplyMerged!({ ...held, attachments: [att('a1')] } as unknown as Blob, 1) })
    await settle(60)
    expect(ids(report().attachments)).toEqual(['a1'])
    expect(save).not.toHaveBeenCalled()
    // the remote removal applies, the local add stays (MERGE_POLICY · attachments: by id)
    await addThenPull(sync, { ...held, attachments: [] } as unknown as Blob)
    const shown = ids(report().attachments)
    expect(shown).toHaveLength(1)
    expect(shown[0]).not.toBe('a1')
    expect(ids((save.mock.lastCall![0] as Saved).attachments)).toEqual(shown)
  })
})

// toast diet call 6 (17.11.2026): a merge that takes ↶'s own step used to raise a toast per merge.
// Now the NEXT ↶ press says it at the button and does not step; the press after it steps.
describe('(f) ↶ after a merge took its step', () => {
  const lastMittel = () => rec.mittel[rec.mittel.length - 1] as { entries: MittelEntry[]; onSave: (d: MittelDraft) => void }
  const undoButton = () => screen.getAllByRole('button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Rückgängig'))!

  it('says it on the next press, without a toast, and steps on the press after', async () => {
    const m = meta()
    savePrefs({ ...loadPrefs(), mode: 'mittel', modeIncidentId: m.id })
    const sync = new WorkspaceSync(m.id)
    const { tree } = workspaceTree(m, { sync, workspace: { entities: [truck], mittel: [] } as unknown as Saved })
    render(tree)
    await settle(60); await settle(60)
    act(() => lastMittel().onSave({ label: 'Schlauch 55', unit: 'Stk', menge: 1 }))
    await settle(60)
    act(() => lastMittel().onSave({ label: 'Ölbinder', unit: 'Sack', menge: 2 }))
    await settle(60)
    const [first, second] = lastMittel().entries
    // another device changed the Ölbinder line: ↶'s own step (that line) is gone, «Schlauch 55» stays on it
    const merged = { entities: [truck], mittel: [first, { ...second, menge: 5 }] } as unknown as Parameters<NonNullable<typeof sync.onApplyMerged>>[0]
    act(() => sync.onApplyMerged!(merged, 1))
    await settle(60)
    const lost = fillTemplate(appConfig.copy.undoTopDropped, { what: appConfig.copy.undoDroppedWhat.mittel })
    expect(document.querySelector('.toaster')?.textContent ?? '').not.toContain(lost)

    fireEvent.click(undoButton())
    await settle(60)
    expect(document.body.textContent).toContain(lost)
    expect(lastMittel().entries.map((e) => e.label)).toEqual(['Schlauch 55', 'Ölbinder'])

    // the press after it steps: «Schlauch 55» goes, the other device's Ölbinder stays
    fireEvent.click(undoButton())
    await settle(60)
    expect(lastMittel().entries.map((e) => e.label)).toEqual(['Ölbinder'])
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

/* A Notiz placed and being typed, and a ↶ that takes back the placing: the Notiz goes, and its editor
   goes with it, without a blur. Its typing must end with no step – one would bring the Notiz back
   empty and clear ↷ (sweep 26.11.2026, after #801). */
describe('(n) ↶ takes back a Notiz while it is being typed', () => {
  const historyButton = (label: string) => screen.getAllByRole('button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith(label))!
  const notes = () => lastMap().entities.filter((e) => e.kind === 'note').map((e) => e.label)
  /** the Notiz tool, one tap on the map: the Notiz is placed and its panel opens with the caret in it */
  const placeNote = async () => {
    key('n')
    act(() => (lastMap() as unknown as { onMapClick: (c: [number, number]) => void }).onMapClick([7.601, 47.501]))
    await settle()
    return lastMap().entities.find((e) => e.kind === 'note')!.id
  }
  const press = async (label: string) => { fireEvent.click(historyButton(label)); await settle() }

  it('in its panel: ↷ brings it back with what was typed', async () => {
    await mount()
    await placeNote()
    const field = document.querySelector<HTMLTextAreaElement>('.ctx-note-input')!
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'Wasser ab 14:20' } })
    await press(appConfig.copy.undo)
    expect(notes()).toEqual([])
    await press(appConfig.copy.redo)
    expect(notes()).toEqual(['Wasser ab 14:20'])
  })

  it('in the editor on the map: ↷ brings it back with what was typed', async () => {
    await mount()
    const id = await placeNote()
    const map = () => lastMap() as unknown as { onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void }
    act(() => map().onNoteEdit(id))
    act(() => map().onNoteText(id, 'Wasser ab 14:20'))
    await settle()
    await press(appConfig.copy.undo)
    expect(notes()).toEqual([])
    // the editor went with the Notiz, and ends its edit as it goes (EntityMarker · NoteField)
    act(() => map().onNoteCommit(id, 'Wasser ab 14:20'))
    await press(appConfig.copy.redo)
    expect(notes()).toEqual(['Wasser ab 14:20'])
  })

  // a double tap on another Notiz opens its editor; the first one's goes and ends its edit then
  it('the editor of the Notiz opened next stays open when the first one’s edit ends', async () => {
    const note = (id: string) => ({ id, kind: 'note', coord: [7.601, 47.501], label: '' }) as Entity
    await mount({ workspace: { entities: [truck, note('a'), note('b')] } as unknown as Saved })
    const map = () => lastMap() as unknown as { editNoteId: string | null; onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void }
    act(() => map().onNoteEdit('a'))
    act(() => map().onNoteText('a', 'Wasser ab 14:20'))
    act(() => map().onNoteEdit('b'))
    act(() => map().onNoteCommit('a', 'Wasser ab 14:20'))
    await settle()
    expect(map().editNoteId).toBe('b')
  })

  // ↶ takes back placing Notiz B while Notiz A's text is typed on the map: A gets its old text
  // back, then A's editor goes. Its end must lay no step and write no row – the history holds it
  it('a ↶ while another Notiz is typed: its end lays no step and writes no row with the taken-back text', async () => {
    const append = vi.spyOn(AuditEventStore.prototype, 'append')
    await mount({ workspace: { entities: [truck, { id: 'a', kind: 'note', coord: [7.6, 47.5], label: 'Alt' } as Entity] } as unknown as Saved })
    await placeNote()
    const map = () => lastMap() as unknown as { onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void }
    act(() => map().onNoteEdit('a'))
    act(() => map().onNoteText('a', 'Neu'))
    await press(appConfig.copy.undo)
    expect(notes()).toEqual(['Alt'])
    act(() => map().onNoteCommit('a', 'Neu'))
    await settle()
    const edits = append.mock.calls.map(([e]) => e).filter((e) => e.op_type === 'entity.edit')
    expect(edits.map((e) => (e.payload as { patch?: { label?: string } }).patch?.label)).not.toContain('Neu')
    await press(appConfig.copy.redo)
    expect(notes()).toEqual(['Neu', ''])
  })

  // the map editor stays open through the ↶; what is typed after it is an edit of its own
  it('typed on after a ↶: the new text is its own ↶ step with its one row', async () => {
    const append = vi.spyOn(AuditEventStore.prototype, 'append')
    await mount({ workspace: { entities: [truck, { id: 'a', kind: 'note', coord: [7.6, 47.5], label: 'Alt' } as Entity] } as unknown as Saved })
    await placeNote()
    const map = () => lastMap() as unknown as { onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void }
    act(() => map().onNoteEdit('a'))
    act(() => map().onNoteText('a', 'Erst'))
    await press(appConfig.copy.undo)
    expect(notes()).toEqual(['Alt'])
    act(() => map().onNoteText('a', 'Alt, Wasser ab 14:20'))
    act(() => map().onNoteCommit('a', 'Alt, Wasser ab 14:20'))
    await settle()
    const rows = append.mock.calls.map(([e]) => e).filter((e) => e.op_type === 'entity.edit')
      .map((e) => (e.payload as { patch?: { label?: string } }).patch?.label)
    expect(rows).toEqual(['Alt, Wasser ab 14:20'])
    await press(appConfig.copy.undo)
    expect(notes()).toEqual(['Alt'])
    await press(appConfig.copy.redo)
    expect(notes()).toEqual(['Alt, Wasser ab 14:20'])
  })

  // a vehicle moved while a Notiz has the caret takes the one gesture slot and keeps its own ↶
  // step; the Notiz's typing lays none then (open point), but its row is still written
  describe('a vehicle moved while a Notiz is typed', () => {
    type Drag = { onMarkerDragStart: (id: string) => void; onMarkerMove: (id: string, c: [number, number]) => void; onMarkerDragEnd: (id: string, c: [number, number]) => void }
    const map = () => lastMap() as unknown as Drag & { onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void }
    const truckAt = () => lastMap().entities.find((e) => e.id === truck.id)?.coord
    const typeThenMove = async () => {
      const append = vi.spyOn(AuditEventStore.prototype, 'append')
      await mount({ workspace: { entities: [truck, { id: 'a', kind: 'note', coord: [7.6, 47.5], label: 'Alt' } as Entity] } as unknown as Saved })
      act(() => map().onNoteEdit('a'))
      act(() => map().onNoteText('a', 'Wasser ab 14:20'))
      act(() => map().onMarkerDragStart(truck.id))
      act(() => map().onMarkerMove(truck.id, [7.61, 47.5]))
      act(() => map().onMarkerDragEnd(truck.id, [7.61, 47.5]))
      await settle()
      const rows = () => append.mock.calls.map(([e]) => e).filter((e) => e.op_type === 'entity.edit' && (e.payload as { id?: string }).id === 'a')
        .map((e) => (e.payload as { patch?: { label?: string } }).patch?.label)
      return { rows }
    }

    it('the Notiz still writes its one row, and the move stays one ↶ step', async () => {
      const { rows } = await typeThenMove()
      act(() => map().onNoteCommit('a', 'Wasser ab 14:20'))
      await settle()
      expect(rows()).toEqual(['Wasser ab 14:20'])
      await press(appConfig.copy.undo)
      expect(truckAt()).toEqual(truck.coord)
    })

    // the ↶ takes back the move only: the Notiz still holds what was typed, so the row stays
    // (a ↶ that takes the typed text back writes none – «a ↶ while another Notiz is typed» above)
    it('…also when a ↶ took back only the move', async () => {
      const { rows } = await typeThenMove()
      await press(appConfig.copy.undo)
      expect(truckAt()).toEqual(truck.coord)
      expect(notes()).toEqual(['Wasser ab 14:20'])
      act(() => map().onNoteCommit('a', 'Wasser ab 14:20'))
      await settle()
      expect(rows()).toEqual(['Wasser ab 14:20'])
    })

    it('typed on after that ↶: one row with the final text', async () => {
      const { rows } = await typeThenMove()
      await press(appConfig.copy.undo)
      act(() => map().onNoteText('a', 'Wasser ab 14:30'))
      act(() => map().onNoteCommit('a', 'Wasser ab 14:30'))
      await settle()
      expect(rows()).toEqual(['Wasser ab 14:30'])
    })
  })

  // after a ↶, an existing Notiz opened on the map and closed with ✓, nothing typed
  it('✓ on an unchanged Notiz lays no step: ↷ stays', async () => {
    await mount({ workspace: { entities: [truck, { id: 'a', kind: 'note', coord: [7.6, 47.5], label: 'Alt' } as Entity] } as unknown as Saved })
    await placeNote()
    await press(appConfig.copy.undo)
    const map = () => lastMap() as unknown as { onNoteEdit: (id: string) => void; onNoteCommit: (id: string, v: string) => void }
    act(() => map().onNoteEdit('a'))
    act(() => map().onNoteCommit('a', 'Alt'))
    await settle()
    await press(appConfig.copy.redo)
    expect(notes()).toEqual(['Alt', ''])
  })
})

/* A Notiz TYPED on the Lage – in the editor on the map or in its panel – wrote only its audit row,
   never the Verlauf (sweep 25.11.2026, Notiz Verlauf round): one row per typing session, the bare
   «Notiz «…»» the Plan writes, at the moment the session ends (IncidentWorkspace · noteTextEnd). */
describe('(n) a Notiz typed on the Lage writes its Verlauf row', () => {
  const N = appConfig.copy
  const written = (value: string) => fillTemplate(N.log.noteWritten, { value })
  const alt = { id: 'a', kind: 'note', coord: [7.6, 47.5], label: 'Alt' } as Entity
  type NoteMap = { onNoteEdit: (id: string) => void; onNoteText: (id: string, v: string) => void; onNoteCommit: (id: string, v: string) => void; onNotePanel: (id: string) => void }
  const map = () => lastMap() as unknown as NoteMap
  const labelOfA = () => lastMap().entities.find((e) => e.id === 'a')?.label
  /** every Verlauf row written since `start`, and whether its journal was already disposed */
  const realAppend = JournalStore.prototype.append
  const journalRows = () => {
    const seen: { text: string; disposed: boolean }[] = []
    vi.spyOn(JournalStore.prototype, 'append').mockImplementation(function (this: JournalStore, row) {
      seen.push({ text: row.text, disposed: this.isDisposed })
      return realAppend.call(this, row)
    })
    return seen
  }
  /** the Lage with Notiz «Alt»; `rows` is every Verlauf row written since, `noteRows` the Notiz text rows */
  const start = async (over: Partial<WsProps> = {}) => {
    const seen = journalRows()
    const m = meta()
    const sync = new WorkspaceSync(m.id)
    const tree = (im: IncidentMeta, more: Partial<WsProps> = {}) => workspaceTree(im, { sync, workspace: { entities: [truck, alt] } as unknown as Saved, ...over, ...more }).tree
    const utils = render(tree(m))
    await settle()
    seen.length = 0
    const rows = () => seen.map((r) => r.text)
    const noteRows = () => rows().filter((t) => t === N.log.notesCleared || t.startsWith(fillTemplate(N.log.noteWritten, { value: '' }).slice(0, -1)))
    /** the Einsatz closed on another device: the Karte locks, in the same mount */
    const lock = async () => {
      const at = new Date()
      utils.rerender(tree({ ...m, is_archived: true, closed_at: at.toISOString() }, { lifecycleElsewhere: { event: 'closed', at: at.getTime() } }))
      await settle(60)
    }
    /** another device's text for Notiz A arrives (the three-way merge) */
    const remote = async (label: string) => {
      act(() => sync.onApplyMerged!({ entities: [truck, { ...alt, label }] } as unknown as Parameters<NonNullable<typeof sync.onApplyMerged>>[0], 1))
      await settle(60)
    }
    return { ...utils, seen, rows, noteRows, lock, remote }
  }
  const field = () => document.querySelector<HTMLTextAreaElement>('.ctx-note-input')!
  const typeInPanel = (v: string) => { act(() => { field().focus() }); fireEvent.change(field(), { target: { value: v } }) }
  /** the panel's «Entfernen» – it draws its actions twice (inline and as the footer, by layout) */
  const removeButton = () => screen.getAllByRole('button', { name: N.remove })[0]
  /** ⌘Z, as the keyboard gives it – no render needed between it and what came before */
  const undoKey = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }))

  describe('in the editor on the map', () => {
    const type = (v: string) => act(() => map().onNoteText('a', v))
    const end = async (v: string) => { act(() => map().onNoteCommit('a', v)); await settle() }

    it('typed, the editor ends: one bare row', async () => {
      const { rows } = await start()
      act(() => map().onNoteEdit('a'))
      type('Wasser')
      type('Wasser ab 14:20')
      await end('Wasser ab 14:20')
      expect(rows()).toEqual([written('Wasser ab 14:20')])
    })

    it('opened and closed with no change, or typed back to its text: no row', async () => {
      const { rows } = await start()
      act(() => map().onNoteEdit('a'))
      await end('Alt')
      act(() => map().onNoteEdit('a'))
      type('Altx')
      type('Alt')
      await end('Alt')
      expect(rows()).toEqual([])
    })

    it('emptied: the bare cleared wording', async () => {
      const { rows } = await start()
      act(() => map().onNoteEdit('a'))
      type('')
      await end('')
      expect(rows()).toEqual([N.log.notesCleared])
    })

    it('two sessions: two rows', async () => {
      const { rows } = await start()
      act(() => map().onNoteEdit('a'))
      type('Wasser')
      await end('Wasser')
      act(() => map().onNoteEdit('a'))
      type('Wasser ab 14:20')
      await end('Wasser ab 14:20')
      expect(rows()).toEqual([written('Wasser'), written('Wasser ab 14:20')])
    })

    // the session is over before the ↶ starts: the ↶ takes back the text, never the row
    it('ended, then ↶ in the same moment: the row stays', async () => {
      const { noteRows } = await start()
      act(() => map().onNoteEdit('a'))
      type('Wasser ab 14:20')
      act(() => { map().onNoteCommit('a', 'Wasser ab 14:20'); undoKey() })
      await settle()
      expect(labelOfA()).toBe('Alt')
      expect(noteRows()).toEqual([written('Wasser ab 14:20')])
    })

    // the editor goes with the Notiz and ends its edit as it goes (EntityMarker · NoteField)
    it('typed, then removed in the same session: no «written» row', async () => {
      const { rows } = await start()
      act(() => map().onNoteEdit('a'))
      type('Wasser ab 14:20')
      act(() => { lastMap().onSelect(lastMap().entities.find((e) => e.id === 'a')!) })
      key('Delete')
      await end('Wasser ab 14:20')
      expect(lastMap().entities.some((e) => e.id === 'a')).toBe(false)
      expect(rows()).not.toContain(written('Wasser ab 14:20'))
    })

    // the editor only had the caret; its end hands back the text it was opened with
    it('opened, another device writes the text, the editor ends unchanged: that text stays, no row', async () => {
      const { rows, remote } = await start()
      act(() => map().onNoteEdit('a'))
      await remote('Neu von Tablet 2')
      await end('Alt')
      expect(labelOfA()).toBe('Neu von Tablet 2')
      expect(rows()).toEqual([])
    })

    // the lock takes the editor under every tool («Auswahl» too); its field ends the typing as it
    // goes (NoteField · useCommitDraftOnUnmount → MapMarkers · noteEnd, MapMarkers.test), with its row
    it('typed, then the Einsatz is closed on another device: the editor goes, the typing ends with its row', async () => {
      const { noteRows, lock } = await start()
      act(() => map().onNoteEdit('a'))
      type('Wasser ab 14:20')
      await lock()
      expect((lastMap() as unknown as { editNoteId: string | null }).editNoteId).toBeNull()
      await end('Wasser ab 14:20')
      expect(noteRows()).toEqual([written('Wasser ab 14:20')])
    })
  })

  // A's editor keeps the caret while B's panel is open (a tap, or a press on «Entfernen», moves no focus)
  describe('two Notizen', () => {
    const b = { id: 'b', kind: 'note', coord: [7.601, 47.501], label: 'Beta' } as Entity
    const both = () => start({ workspace: { entities: [truck, alt, b] } as unknown as Saved })
    const openB = async () => {
      act(() => { lastMap().onSelect(lastMap().entities.find((e) => e.id === 'b')!); map().onNotePanel('b') })
      await settle()
    }
    const audit = () => vi.spyOn(AuditEventStore.prototype, 'append')

    it('B removed by its panel while A is typed: A keeps its session and its row, B gets no edit', async () => {
      const edits = audit()
      const { noteRows } = await both()
      act(() => map().onNoteEdit('a'))
      act(() => map().onNoteText('a', 'Wasser ab 14:20'))
      await openB()
      fireEvent.click(removeButton())
      await settle()
      expect(lastMap().entities.some((e) => e.id === 'b')).toBe(false)
      act(() => map().onNoteCommit('a', 'Wasser ab 14:20'))
      await settle()
      expect(noteRows()).toEqual([written('Wasser ab 14:20')])
      const editIds = edits.mock.calls.map(([e]) => e).filter((e) => e.op_type === 'entity.edit').map((e) => (e.payload as { id?: string }).id)
      expect(editIds).toEqual(['a'])
    })
  })

  describe('in its panel', () => {
    /** a size in the open panel – a style edit, written through patchEntity */
    const size = (name: string) => fireEvent.click(within(within(field().closest<HTMLElement>('.ctx-note')!).getByText(N.notes.size).closest<HTMLElement>('.field')!).getByRole('button', { name }))
    /** the tap that selects the Notiz opens its panel (MapMarkers · onNotePanel) */
    const open = async () => {
      act(() => { lastMap().onSelect(lastMap().entities.find((e) => e.id === 'a')!); map().onNotePanel('a') })
      await settle()
    }

    it('typed, the field blurred: one bare row', async () => {
      const { rows } = await start()
      await open()
      typeInPanel('Wasser')
      typeInPanel('Wasser ab 14:20')
      fireEvent.blur(field())
      await settle()
      expect(rows()).toEqual([written('Wasser ab 14:20')])
    })

    it('opened and closed with no change: no row', async () => {
      const { rows } = await start()
      await open()
      fireEvent.click(screen.getByRole('button', { name: N.closeDialog }))
      await settle()
      expect(rows()).toEqual([])
    })

    it('two sessions: two rows', async () => {
      const { rows } = await start()
      await open()
      typeInPanel('Wasser')
      fireEvent.blur(field())
      await settle()
      typeInPanel('Wasser ab 14:20')
      fireEvent.click(screen.getByRole('button', { name: N.closeDialog }))
      await settle()
      expect(rows()).toEqual([written('Wasser'), written('Wasser ab 14:20')])
    })

    // the edit row's settle window (patchEntity) spans the typing: it must not say the text again
    it('a style edit before and after the typing: one row', { timeout: 15_000 }, async () => {
      const { rows } = await start()
      await open()
      size(N.notes.sizeL)
      typeInPanel('Wasser ab 14:20')
      // a real blur: the caret leaves the field, so the settle window may close
      act(() => { field().blur() })
      await settle()
      size(N.notes.sizeS)
      await settle(4_500)
      expect(rows()).toEqual([written('Wasser ab 14:20')])
    })

    // …nor say a text back that a ↶ restored after the typing's own row
    it('a style edit, typed, ↶, a style edit: no row for the text the ↶ gave back', { timeout: 15_000 }, async () => {
      const { noteRows } = await start()
      await open()
      size(N.notes.sizeL)
      typeInPanel('Neu')
      act(() => { field().blur() })
      await settle()
      act(() => { undoKey() })
      await settle()
      expect(labelOfA()).toBe('Alt')
      size(N.notes.sizeS)
      await settle(4_500)
      expect(noteRows()).toEqual([written('Neu')])
    })

    it('typed, then the Einsatz is closed on another device: the typing ends with its row', async () => {
      const { noteRows, lock } = await start()
      await open()
      typeInPanel('Wasser ab 14:20')
      await lock()
      expect(field()).toBeNull()
      expect(noteRows()).toEqual([written('Wasser ab 14:20')])
    })

    // the field's end runs in the teardown's layout phase, before the workspace disposes its journal
    // (lib/useCommitDraftOnUnmount)
    it('typed, then the workspace goes: the row reaches its journal before it closes', async () => {
      const { seen, unmount } = await start()
      await open()
      typeInPanel('Wasser ab 14:20')
      unmount()
      expect(seen.filter((r) => r.text === written('Wasser ab 14:20'))).toEqual([{ text: written('Wasser ab 14:20'), disposed: false }])
    })

    // a tap keeps the caret in the field: «Entfernen» ends the typing without its row, then removes
    it('typed, then «Entfernen» by touch: no «written» row', async () => {
      const { rows } = await start()
      await open()
      typeInPanel('Wasser ab 14:20')
      fireEvent.click(removeButton())
      await settle()
      expect(lastMap().entities.some((e) => e.id === 'a')).toBe(false)
      expect(rows()).not.toContain(written('Wasser ab 14:20'))
    })

    // a mouse press moves the focus unless its default is prevented – what the browser does then
    // is done here (the blur), and the click comes as its own task
    it('typed, then «Entfernen» by mouse: no «written» row', async () => {
      const { rows } = await start()
      await open()
      typeInPanel('Wasser ab 14:20')
      const press = createEvent.mouseDown(removeButton())
      fireEvent(removeButton(), press)
      if (!press.defaultPrevented) act(() => { field().blur() })
      await settle()
      fireEvent.click(removeButton())
      await settle()
      expect(lastMap().entities.some((e) => e.id === 'a')).toBe(false)
      expect(rows()).not.toContain(written('Wasser ab 14:20'))
    })
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
