// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMapActions, writesLive, type UseMapActionsInputs } from './useMapActions'
import { replayEmits } from '../lib/replay.test-utils'
import type { Doc } from '../lib/workspace'
import type { Drawing, Entity, LineAttachment } from '../types'
import type { SetStateAction } from 'react'
import type { VehicleOverrides } from '../lib/useVehicleLayer'
import { createUndoTimeline, type UndoDomain } from '../lib/undoTimeline'
import type { RecordKey } from '../lib/undoKeys'
import type { TacticalObject } from '../lib/tacticalObjects'
import { appConfig } from '../config/appConfig'
// the ERG rows under a placard's rings, injected the way the boot prefetch would (lib/staticData)
import ergData from '../../public/erg.json'
import { __setErgData, type ErgData } from '../lib/erg'
__setErgData(ergData as unknown as ErgData)

vi.mock('../lib/ui', () => ({ toast: vi.fn(), confirmDialog: vi.fn(async () => true), undoToast: vi.fn() }))

const ent = (id: string, coord: [number, number]): Entity => ({ id, kind: 'symbol', layer: 'l', coord, symbol: 'X' }) as Entity
const leitung = (over: Partial<Drawing>): Drawing => ({ id: 'h', kind: 'line', coords: [[0, 0], [5, 5], [9, 9]], ...over }) as Drawing
const onObject = (id: string): LineAttachment => ({ target: { kind: 'object', id }, routing: 'direct' })

// The inputs the delete paths read, over a live doc the commit stub applies to; every other
// input is an inert stub (the hook's mount effects only read refs and flags).
function makeDeps(entities: Entity[], drawings: Drawing[]) {
  let doc = { entities, drawings } as unknown as Doc
  const given = {
    entities, drawings, doc, tacticalLocked: false, liveIds: new Set<string>(), selectedId: null, editNoteId: null,
    planDocs: [], trupps: [], objects: [], selectedDrawIds: [], selectedEntityIds: [], mode: 'map' as const,
    commit: vi.fn((u: (d: Doc) => Doc) => { doc = u(doc) }),
    emit: vi.fn(),
    log: vi.fn(),
    // the ↶ caption a removal lays (the delete rule names its step there, never in a toast)
    stepLabelRef: { current: null as string | null },
  } satisfies Partial<UseMapActionsInputs>
  const deps = new Proxy(given, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : (k === 'then' ? undefined : vi.fn())),
  }) as unknown as UseMapActionsInputs
  return { deps, given, live: () => doc }
}

afterEach(() => { vi.clearAllMocks() })

// Deleting a symbol lets go of every Leitung end hanging on it. Both ends of one line on the
// deleted object(s) used to go out as two `draw.edit`s, each built from the line's ORIGINAL
// coords — so replay folded the second over the first and put the first end back.
describe('delete — a line with both ends on what goes', () => {
  it('deleteGroup: replay shows both ends moved for a line between two deleted symbols', async () => {
    const entities = [ent('a', [1, 1]), ent('b', [2, 2])]
    const drawings = [leitung({ startAttachment: onObject('a'), endAttachment: onObject('b') })]
    const { deps, given, live } = makeDeps(entities, drawings)
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteGroup([], ['a', 'b']) })
    expect(live().drawings[0].coords).toEqual([[1, 1], [5, 5], [2, 2]])
    const replayed = await replayEmits({ entities, drawings }, given.emit.mock.calls)
    expect(replayed.drawings[0].coords).toEqual([[1, 1], [5, 5], [2, 2]])
    expect(given.emit.mock.calls.filter(([op]) => op === 'draw.edit')).toHaveLength(1)
  })

  it('deleteEntity: replay shows both ends moved for a line with both ends on the symbol', async () => {
    const entities = [ent('a', [1, 1])]
    const drawings = [leitung({ startAttachment: onObject('a'), endAttachment: onObject('a') })]
    const { deps, given, live } = makeDeps(entities, drawings)
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteEntity('a') })
    expect(live().drawings[0].coords).toEqual([[1, 1], [5, 5], [1, 1]])
    const replayed = await replayEmits({ entities, drawings }, given.emit.mock.calls)
    expect(replayed.drawings[0].coords).toEqual([[1, 1], [5, 5], [1, 1]])
    expect(given.emit.mock.calls.filter(([op]) => op === 'draw.edit')).toHaveLength(1)
  })
})

// …and the coupling goes with it in replay too: a cleared end used to travel as `undefined`,
// which JSON drops, so the replayed line still hung on the deleted symbols.
describe('delete — replay clears the freed ends\' attachments', () => {
  it('deleteGroup: the replayed line hangs on nothing', async () => {
    const entities = [ent('a', [1, 1]), ent('b', [2, 2])]
    const drawings = [leitung({ startAttachment: onObject('a'), endAttachment: onObject('b') })]
    const { deps, given } = makeDeps(entities, drawings)
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteGroup([], ['a', 'b']) })
    const [replayed] = (await replayEmits({ entities, drawings }, given.emit.mock.calls)).drawings
    expect(replayed).not.toHaveProperty('startAttachment')
    expect(replayed).not.toHaveProperty('endAttachment')
  })
})

// Owner 14.11.2026: a symbol that Leitungen hang on asks first – «TLF hat 2 Leitungen» ·
// [Nur Symbol] [Mit Leitungen] [Abbrechen]; either answer is ONE commit (one ↶ step that gives
// back everything, named on the ↶ – no toast, owner pick 28), and a symbol with nothing joined
// goes without a card.
describe('delete — the joined-lines card', () => {
  const tlf = (): Entity => ({ ...ent('a', [1, 1]), label: 'TLF' })
  const hoses = () => [
    leitung({ id: 'h1', startAttachment: onObject('a') }),
    // its other end hangs on another symbol: it still goes with «Mit Leitungen»
    leitung({ id: 'h2', startAttachment: onObject('b'), endAttachment: onObject('a') }),
    leitung({ id: 'free' }),
  ]
  const answer = async (a: boolean | 'alt') => {
    const ui = await import('../lib/ui')
    vi.mocked(ui.confirmDialog).mockResolvedValueOnce(a as never)
    return ui
  }

  it('nothing joined: no card, one commit', async () => {
    const ui = await import('../lib/ui')
    const { deps, given, live } = makeDeps([tlf()], [leitung({ id: 'free' })])
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteEntity('a') })
    expect(ui.confirmDialog).not.toHaveBeenCalled()
    expect(given.commit).toHaveBeenCalledTimes(1)
    expect(live().entities).toEqual([])
  })

  it('«Nur Symbol»: the lines stay, let go where the symbol stood – one commit', async () => {
    const ui = await answer(true)
    const { deps, given, live } = makeDeps([tlf(), ent('b', [3, 3])], hoses())
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteEntity('a') })
    expect(vi.mocked(ui.confirmDialog).mock.calls[0][0]).toMatchObject({ title: 'TLF hat 2 Leitungen', confirmLabel: 'Nur Symbol', altLabel: 'Mit Leitungen' })
    expect(given.commit).toHaveBeenCalledTimes(1)
    expect(live().drawings.map((d) => d.id)).toEqual(['h1', 'h2', 'free'])
    expect(live().drawings[0].startAttachment).toBeUndefined()
    expect(given.stepLabelRef.current).toBe('TLF entfernt, 2 Leitungen gelöst')
    expect(ui.toast).not.toHaveBeenCalled()
  })

  it('«Mit Leitungen»: the symbol and every line on it go in one commit, and the ↶ says so', async () => {
    const ui = await answer('alt')
    const { deps, given, live } = makeDeps([tlf(), ent('b', [3, 3])], hoses())
    const { result } = renderHook(() => useMapActions(deps))
    let went: boolean | undefined
    await act(async () => { went = await result.current.deleteEntity('a') })
    expect(went).toBe(true)
    expect(given.commit).toHaveBeenCalledTimes(1)
    expect(live().entities.map((e) => e.id)).toEqual(['b'])
    expect(live().drawings.map((d) => d.id)).toEqual(['free'])
    expect(given.stepLabelRef.current).toBe('TLF und 2 Leitungen entfernt')
    expect(ui.toast).not.toHaveBeenCalled()
    expect(given.emit.mock.calls.filter(([op]) => op === 'draw.delete').map(([, p]) => p.id)).toEqual(['h1', 'h2'])
  })

  it('Abbrechen: nothing is written', async () => {
    await answer(false)
    const { deps, given } = makeDeps([tlf()], hoses())
    const { result } = renderHook(() => useMapActions(deps))
    let went: boolean | undefined
    await act(async () => { went = await result.current.deleteEntity('a') })
    expect(went).toBe(false)
    expect(given.commit).not.toHaveBeenCalled()
    expect(given.emit).not.toHaveBeenCalled()
  })

  it('a group asks once, the lines counted over all of it', async () => {
    const ui = await answer('alt')
    const { deps, given, live } = makeDeps([tlf(), ent('b', [3, 3])], hoses())
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { await result.current.deleteGroup(['free'], ['a', 'b']) })
    expect(ui.confirmDialog).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ui.confirmDialog).mock.calls[0][0]).toMatchObject({ title: 'Auswahl hat 2 Leitungen', confirmLabel: 'Nur Auswahl' })
    expect(given.commit).toHaveBeenCalledTimes(1)
    expect(live()).toMatchObject({ entities: [], drawings: [] })
    expect(given.stepLabelRef.current).toBe('3 Objekte und 2 Leitungen entfernt')
    expect(ui.toast).not.toHaveBeenCalled()
  })
})

// hunt 24.11.2026, frontend-state F4: «Zurück auf GPS» dropped the vehicle's whole override row –
// Fahrer and Herkunft with it – and laid no undo step
describe('resetVehicleGps', () => {
  it('takes only the hand position, keeps Fahrer and Herkunft, as one ↶ step', () => {
    let overrides: VehicleOverrides = { v1: { coord: [7, 47], rotation: 0, fahrer: 'Meier', herkunft: 'Oberwil' }, v2: { coord: [8, 47] } }
    const timeline = createUndoTimeline()
    const { deps } = makeDeps([], [])
    Object.assign(deps, {
      vehicleOverrides: overrides,
      setVehicleOverrides: (u: SetStateAction<VehicleOverrides>) => { overrides = typeof u === 'function' ? u(overrides) : u },
      rememberOneShotRef: { current: (domain: UndoDomain, label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null) =>
        timeline.push({ domain, label, touches, undo: () => { restore() }, redo: () => { reapply() } }) },
    })
    const { result } = renderHook(() => useMapActions(deps))
    act(() => { result.current.resetVehicleGps('v1', 'TLF') })
    expect(overrides).toEqual({ v1: { fahrer: 'Meier', herkunft: 'Oberwil' }, v2: { coord: [8, 47] } })
    expect(timeline.peekUndo()?.label).toBe('TLF zurück auf GPS')
    expect(timeline.peekUndo()?.touches?.()).toEqual(['vehicleOverrides:v1'])
    timeline.undo()
    expect(overrides.v1).toEqual({ coord: [7, 47], rotation: 0, fahrer: 'Meier', herkunft: 'Oberwil' })
    timeline.redo()
    expect(overrides.v1).toEqual({ fahrer: 'Meier', herkunft: 'Oberwil' })
  })

  // review of #742: a drag after the reset lays no step, so the reset's ↶ wrote the older
  // coordinate over it — the hand placement makes the reset permanent instead
  it('a vehicle dragged after the reset keeps the drag: the reset step is off the timeline', () => {
    let overrides: VehicleOverrides = { v1: { coord: [7, 47], fahrer: 'Meier' } }
    const timeline = createUndoTimeline()
    const { deps } = makeDeps([], [])
    Object.assign(deps, {
      vehicleOverrides: overrides, liveIds: new Set(['v1']),
      setVehicleOverrides: (u: SetStateAction<VehicleOverrides>) => { overrides = typeof u === 'function' ? u(overrides) : u },
      rememberOneShotRef: { current: (domain: UndoDomain, label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null) =>
        timeline.push({ domain, label, touches, undo: () => { restore() }, redo: () => { reapply() } }) },
    })
    const { result } = renderHook(() => useMapActions(deps))
    act(() => { result.current.resetVehicleGps('v1', 'TLF') })
    act(() => { result.current.finishEntityMove('v1', [8, 46]) })
    expect(timeline.canUndo()).toBe(false)
    timeline.undo()
    expect(overrides.v1).toEqual({ fahrer: 'Meier', coord: [8, 46] })
  })

  it('a row with nothing but the hand position goes whole', () => {
    let overrides: VehicleOverrides = { v1: { coord: [7, 47] } }
    const { deps } = makeDeps([], [])
    Object.assign(deps, {
      vehicleOverrides: overrides,
      setVehicleOverrides: (u: SetStateAction<VehicleOverrides>) => { overrides = typeof u === 'function' ? u(overrides) : u },
      rememberOneShotRef: { current: () => Object.assign(() => {}, { standing: () => true }) },
    })
    const { result } = renderHook(() => useMapActions(deps))
    act(() => { result.current.resetVehicleGps('v1', 'TLF') })
    expect(overrides).toEqual({})
  })
})

// owner picks UX journeys B3·33/34 (25.11.2026): «Stattdessen GPS-TLF hier festhalten» – the
// symbol goes, the GPS vehicle is held at its spot, and ONE ↶ gives both back
describe('holdGpsInstead', () => {
  it('removes the symbol and holds the vehicle there, as one ↶ step', async () => {
    let overrides: VehicleOverrides = {}
    const timeline = createUndoTimeline()
    const { deps, given, live } = makeDeps([{ ...ent('p', [7.5, 47.5]), label: 'TLF' }], [])
    let doc = live()
    Object.assign(deps, {
      vehicleOverrides: overrides,
      setVehicleOverrides: (u: SetStateAction<VehicleOverrides>) => { overrides = typeof u === 'function' ? u(overrides) : u },
      // the store's commit as one karte step on the timeline, the way IncidentWorkspace lays it
      commit: (u: (d: Doc) => Doc) => {
        const before = doc
        const after = u(doc)
        doc = after
        timeline.push({ domain: 'karte', label: given.stepLabelRef.current ?? '', undo: () => { doc = before }, redo: () => { doc = after } })
      },
      rememberOneShotRef: { current: (domain: UndoDomain, label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null) =>
        timeline.push({ domain, label, touches, undo: () => { restore() }, redo: () => { reapply() } }) },
      historyGroup: () => timeline.group(),
    })
    const { result } = renderHook(() => useMapActions(deps))
    await act(async () => { result.current.holdGpsInstead('p', 'gps-7', 'TLF') })
    expect(doc.entities).toEqual([])
    expect(overrides).toEqual({ 'gps-7': { coord: [7.5, 47.5] } })
    expect(timeline.peekUndo()?.label).toBe('GPS-TLF statt Symbol festgehalten')
    timeline.undo()
    expect(doc.entities.map((e) => e.id)).toEqual(['p'])
    expect(overrides).toEqual({})
    expect(timeline.canUndo()).toBe(false)
  })
})

// owner sign-off note on B3·33/34 (25.11.2026): «two TLFs can really be there» – «Sind zwei»
// silences the hint for this symbol, as its own named ↶ step
describe('keepGpsTwin', () => {
  it('marks the symbol a second vehicle in one named step', () => {
    const { deps, given } = makeDeps([{ ...ent('p', [7.5, 47.5]), label: 'TLF' }], [])
    const patchEntity = vi.fn()
    Object.assign(deps, { patchEntity })
    const { result } = renderHook(() => useMapActions(deps))
    act(() => { result.current.keepGpsTwin('p', 'TLF') })
    expect(patchEntity).toHaveBeenCalledWith('p', { gpsTwinOk: true })
    expect(given.stepLabelRef.current).toBe('Hinweis «zwei TLF» ausgeblendet')
  })
})

// perf sweep 26.11.2026: a held Karte marker is previewed by its own MapLibre Marker (MapMarkers),
// so a plain one writes the store ONCE, on release; what the picture around it must follow
// (writesLive) still writes per move
describe('a Karte marker drag', () => {
  /** the store's two drag writers over the live doc, counted */
  const store = (entities: Entity[], drawings: Drawing[]) => {
    const { deps, given, live } = makeDeps(entities, drawings)
    let doc = live()
    const writes: { movedIds?: readonly string[] }[] = []
    const beginDrag = vi.fn(), endDrag = vi.fn()
    // the live objects (IncidentWorkspace · objectsRef), what a remote edit mid-drag lands in
    const objectsRef = { current: [] as TacticalObject[] }
    const sync = () => { objectsRef.current = [...doc.entities.map((entity) => ({ id: entity.id, entity })), ...doc.drawings.map((drawing) => ({ id: drawing.id, drawing }))] }
    sync()
    Object.assign(deps, {
      beginDrag, endDrag, objectsRef,
      setDocRaw: (u: SetStateAction<Doc>, opts?: { movedIds?: readonly string[] }) => { doc = typeof u === 'function' ? u(doc) : u; sync(); writes.push(opts ?? {}) },
    })
    /** another device's edit arriving while the finger is down */
    const remote = (next: Doc) => { doc = next; sync() }
    return { deps, given, writes, beginDrag, endDrag, remote, doc: () => doc }
  }
  /** 40 moves from [0, 0] to [40, 0], then the release on the last one */
  const drag = (moves: ReturnType<typeof useMapActions>, id: string) => {
    moves.startEntityMove(id)
    for (let i = 1; i <= 40; i++) moves.streamEntityMove(id, [i, 0])
    moves.finishEntityMove(id, [40, 0])
  }

  it('a plain symbol: 40 moves, ONE store write and ONE step, on release, at the last sample', () => {
    const s = store([ent('a', [0, 0])], [])
    const { result } = renderHook(() => useMapActions(s.deps))
    act(() => { drag(result.current, 'a') })
    expect(s.writes).toEqual([{ movedIds: ['a'] }])
    expect(s.beginDrag).toHaveBeenCalledTimes(1)
    expect(s.endDrag).toHaveBeenCalledTimes(1)
    expect(s.doc().entities[0].coord).toEqual([40, 0])
  })

  it('a symbol a Leitung hangs on writes every move – the hose end follows it live', () => {
    const s = store([ent('a', [0, 0])], [leitung({ endAttachment: { target: { kind: 'object', id: 'a' }, routing: 'trace' } })])
    const { result } = renderHook(() => useMapActions(s.deps))
    act(() => { drag(result.current, 'a') })
    expect(s.writes).toHaveLength(41)
    expect(s.endDrag).toHaveBeenCalledTimes(1)
    const hose = s.doc().drawings[0].coords
    expect(hose[hose.length - 1]).toEqual([40, 0])
  })

  it('a Leitung another device attaches mid-drag makes the rest of the drag write live', () => {
    const s = store([ent('a', [0, 0])], [])
    const { result } = renderHook(() => useMapActions(s.deps))
    act(() => {
      result.current.startEntityMove('a')
      for (let i = 1; i <= 10; i++) result.current.streamEntityMove('a', [i, 0])
      s.remote({ ...s.doc(), drawings: [leitung({ endAttachment: onObject('a') })] })
      for (let i = 11; i <= 20; i++) result.current.streamEntityMove('a', [i, 0])
      result.current.finishEntityMove('a', [20, 0])
    })
    expect(s.writes).toHaveLength(11)
  })

  // both sides of the one rule: what is drawn from the stored coordinate follows live
  it.each<[string, Entity[], Drawing[], boolean]>([
    ['a plain symbol', [ent('a', [0, 0])], [], false],
    ['a Leitung on ANOTHER symbol', [ent('a', [0, 0]), ent('b', [1, 1])], [leitung({ startAttachment: onObject('b') })], false],
    ['a Leitung end on it, «Direkt»', [ent('a', [0, 0])], [leitung({ startAttachment: onObject('a') })], true],
    ['a docked Gefahrentafel', [ent('a', [0, 0]), { ...ent('p', [0, 0]), dockedTo: 'a' }], [], true],
    ['a Form (moved from the bar’s ✥, no preview)', [{ ...ent('a', [0, 0]), kind: 'shape' } as Entity], [], true],
    ['a Gefahrentafel with its ERG rings', [{ ...ent('a', [0, 0]), symbol: appConfig.symbols.placardName, fields: { 'UN-Nr.': '1008' } }], [], true],
    ['a Gefahrentafel with its rings off', [{ ...ent('a', [0, 0]), symbol: appConfig.symbols.placardName, fields: { 'UN-Nr.': '1008' }, ergRings: 'off' }], [], false],
  ])('%s → writes live: %s', (_, entities, drawings, live) => {
    expect(writesLive({ entities, drawings }, 'a')).toBe(live)
  })
})
