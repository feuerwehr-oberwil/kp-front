// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import { act, renderHook } from '@testing-library/react'
import { useObjectStore } from './useObjectStore'
import { useTruppActions } from './useTruppActions'
import { createUndoTimeline } from './undoTimeline'
import { peakAtemschutzAlarm } from './atemschutz'
import { objectsFromLegacy } from './tacticalObjects'
import type { BoardDoc, Drawing, Trupp } from '../types'
import type { Doc } from './workspace'

/**
 * Field report 15.09.2026 (Feuerwehr Oberwil, via Bastian):
 *
 *   «ich hab aus Versehen meine Leitung gelöscht, Undo-Pfeil ging nicht, da mein Trupp überfällig
 *    war. Ich also Trupp-Kontakt bestätigt, dann Undo, kam der überfällige Trupp wieder, aber ich
 *    habe keine Möglichkeit meine Leitung zurückzubekommen.»
 *
 * The ↶ was gone from the phone's top bar for as long as the Atemschutz-Alarmchip was in it
 * (15-mobile.css) — a layout trade, fixed there. What this pins is the half that layout cannot
 * say: the TIMELINE itself never cared about the alarm. An überfälliger Trupp removes no step and
 * gates nothing; a Funkkontakt booked in between is one more step, not a wall; and walking back
 * through it reaches the deleted Leitung with the Kontakt's own record left standing.
 *
 * Deliberately at the store/timeline level and with the REAL writers on both sides (the Karte's
 * `useObjectStore` + `useTruppActions.recordContact`), because the loop was only ever visible
 * where the two domains meet — either one on its own has always been fine.
 */

const LINE: Drawing = { id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]] }
/** last contact 40 min ago: past 20 min + 2 min Nachfrist, i.e. tier 2 «überfällig» */
const OVERDUE_MS = 40 * 60_000

const overdueTrupp = (now: number): Trupp => ({
  id: 'T1', name: 'Keller Anna', entryPressureBar: 300,
  entryTime: new Date(now - OVERDUE_MS).toISOString(),
  lastContactTime: new Date(now - OVERDUE_MS).toISOString(),
  status: 'aktiv',
})

/** peak tier of the app-wide alarm, with the station's default doctrine values */
const peak = (trupps: Trupp[], now: number) => peakAtemschutzAlarm(trupps, now, 20, 120, 60).peak

describe('undo across surfaces — an überfälliger Trupp never stands between ↶ and the Karte', () => {
  it('takes back the Kontakt, then the deleted Leitung — and the Kontakt keeps its Verlauf row', () => {
    const now = Date.now()
    const timeline = createUndoTimeline()

    // ── the Karte, wired exactly as IncidentWorkspace wires it: every checkpoint the store lays
    //    down becomes one delegating «karte» entry on the global timeline.
    const { result: karte } = renderHook(() =>
      useObjectStore(objectsFromLegacy([], [LINE], {}), false, { getFits: () => new Map(), fitsVersion: 0, defaultLayer: 'taktisch' }))
    // through refs, like the real caller: the entry outlives the render that pushed it
    const undoDoc = { current: karte.current.undo }
    const redoDoc = { current: karte.current.redo }

    // ── the Atemschutz side: the real actions over a plain state bag
    const state = { trupps: [overdueTrupp(now)] as Trupp[], board: {} as BoardDoc, doc: { entities: [], drawings: [LINE] } as Doc }
    const rows: string[] = []
    const apply = <T,>(cur: T, a: SetStateAction<T>): T => (typeof a === 'function' ? (a as (p: T) => T)(cur) : a)
    // (a plain closure factory over the injected setters — no hooks inside, so it needs no render)
    const trupps = useTruppActions({
      trupps: state.trupps, drawings: state.doc.drawings, entities: state.doc.entities,
      objects: objectsFromLegacy(state.doc.entities, state.doc.drawings, state.board),
      setTrupps: ((a) => { state.trupps = apply(state.trupps, a) }) as Dispatch<SetStateAction<Trupp[]>>,
      board: state.board,
      setBoard: ((a) => { state.board = apply(state.board, a) }) as Dispatch<SetStateAction<BoardDoc>>,
      setDocRaw: ((a) => { state.doc = apply(state.doc, a) }) as Dispatch<SetStateAction<Doc>>,
      building: null,
      log: (_icon: string, text: string) => { rows.push(text) },
      logPlan: () => {}, emit: () => {},
      setMode: () => {}, setActivePlanId: () => {}, setPanel: () => {}, setPlanFocus: () => {},
      mapCenter: () => [7.5, 47.4], focusMapEntity: () => {}, focusMapDrawing: () => {},
      undoTimeline: timeline,
      liveTrupps: () => state.trupps,
    })

    // 1 · the Leitung is deleted by mistake (the Karte's own commit — one checkpoint, one entry)
    act(() => {
      karte.current.commit((d) => ({ ...d, drawings: d.drawings.filter((dr) => dr.id !== 'd1') }))
      timeline.push({
        domain: 'karte', label: 'Änderung auf der Karte',
        undo: () => undoDoc.current(), redo: () => redoDoc.current(),
      })
    })
    undoDoc.current = karte.current.undo; redoDoc.current = karte.current.redo
    expect(karte.current.doc.drawings).toEqual([])

    // 2 · …while the Trupp is überfällig, which is what made the ↶ unreachable in the field.
    //     The timeline does not know and must not care: the step is still there and still named.
    expect(peak(state.trupps, now)).toBe(2)
    expect(timeline.canUndo()).toBe(true)

    // 3 · the operator confirms the Funkkontakt to silence the alarm — one more step on top
    act(() => trupps.recordContact('T1'))
    expect(peak(state.trupps, Date.now())).toBe(0)
    expect(timeline.peekUndo()?.domain).toBe('trupps')

    // 4 · ↶ takes back the newest thing that happened, which is that Kontakt. The Trupp is
    //     überfällig again — and the Verlauf keeps BOTH rows: what was booked, and that it was
    //     taken back. An append-only record never loses the statement it corrects.
    act(() => { expect(timeline.undo().status).toBe('done') })
    expect(state.trupps[0].readings ?? []).toEqual([])
    expect(peak(state.trupps, now)).toBe(2)
    expect(rows).toEqual([
      'Trupp Keller Anna: Kontakt bestätigt',
      'Trupp Keller Anna: Kontakt bestätigt rückgängig gemacht',
    ])

    // 5 · …and the ↶ below it is the Leitung, still reachable with the Trupp overdue again.
    //     This is the step the field report could never get to.
    expect(timeline.canUndo()).toBe(true)
    act(() => { expect(timeline.undo().status).toBe('done') })
    undoDoc.current = karte.current.undo; redoDoc.current = karte.current.redo
    expect(karte.current.doc.drawings.map((d) => d.id)).toEqual(['d1'])
  })

  /**
   * …and the half that actually broke in the field, which no rendered test can see: the pair was
   * still in the DOM, `canUndo` was still true, and `display: none` took it off the bar for as
   * long as the chip was there. The rule has been written, removed and written again once before
   * (see the block it lives in), so it is pinned here rather than left to a phone in an Einsatz.
   * The chip may take the Einsatzuhr, the weather, the Einsatzname — never the way back.
   */
  it('no stylesheet drops the top bar’s ↶ ↷ because an Atemschutz chip is in the bar', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of ['src/styles/15-mobile.css', 'src/styles/10-journal.css']) {
      const chipRules = readFileSync(file, 'utf-8')
        .split('}').map((block) => block.split('{')[0])
        .filter((sel) => sel.includes(':has(.tb-az)'))
      expect(chipRules.filter((sel) => sel.includes('tb-act-history') || sel.includes('tb-vr-history'))).toEqual([])
    }
  })
})
