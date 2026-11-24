import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { BoardDoc, Drawing, Entity, Trupp } from '../../types'
import { useTruppActions } from '../useTruppActions'
import { objectAttachment } from '../lineAttachments'
import { createUndoTimeline } from '../undoTimeline'
import { truppFieldsOf } from '../atemschutz'
import { replayEmits } from '../replay.test-utils'

vi.mock('../ui', async (load) => ({ ...await load<typeof import('../ui')>(), confirmDialog: vi.fn(async () => false) }))

// A Trupp ⇄ Leitung link is ONE ↶ step over both of its halves: the crew cards it writes and the
// picture (the hose's mirror, the marker at its end). Hunt 24.11.2026, frontend-state F5–F7.

const crew: Trupp = { id: 'C', name: 'Crew', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', entityId: 'M' }
const marker: Entity = { id: 'M', kind: 'team', layer: 'einheiten', truppId: 'C', coord: [7, 47] }
const hose: Drawing = { id: 'H', kind: 'line', coords: [[7.01, 47], [7, 47]], endAttachment: objectAttachment('M') }

/**
 * The Trupp actions over a live picture. `checkpointStore` stands in for the store's step
 * (lib/useObjectStore): ↶ puts the snapshot back, ↷ the state ↶ found.
 */
function fixture(trupps: Trupp[], drawings: Drawing[]) {
  let crews = trupps
  let pic = { entities: [marker], drawings, board: {} as BoardDoc }
  const timeline = createUndoTimeline()
  const emit = vi.fn()
  const apply = <T,>(value: T, update: SetStateAction<T>): T =>
    (typeof update === 'function' ? (update as (x: T) => T)(value) : update)
  /** the actions as one render hands them out (a plain factory: no hook inside) */
  const useActions = () => useTruppActions({
    trupps: crews, drawings: pic.drawings, entities: pic.entities, board: pic.board, objects: [], building: null,
    setTrupps: (u) => { crews = apply(crews, u) },
    setDocRaw: (u) => { const d = apply({ entities: pic.entities, drawings: pic.drawings }, u); pic = { ...pic, ...d } },
    setBoard: (u) => { pic = { ...pic, board: apply(pic.board, u) } },
    liveTrupps: () => crews,
    livePicture: () => pic,
    checkpointStore: () => {
      const snap = pic
      let later = pic
      timeline.push({ domain: 'karte', label: 'Karte', touches: () => [], undo: () => { later = pic; pic = snap }, redo: () => { pic = later } })
    },
    undoTimeline: timeline, log: vi.fn(), emit, logPlan: vi.fn(), setMode: vi.fn(), setActivePlanId: vi.fn(),
    setPanel: vi.fn(), setPlanFocus: vi.fn(), mapCenter: () => [7, 47], focusMapEntity: vi.fn(), focusMapDrawing: vi.fn(),
  })
  return {
    useActions, timeline, emit, marker: () => pic.entities.find((e) => e.id === 'M'), crew: (id = 'C') => crews.find((t) => t.id === id), line: () => pic.drawings.find((d) => d.id === 'H'),
    /** what the drawing tool's own commit does in the same gesture — after the render that handed out the actions */
    draw: (d: Drawing) => { pic = { ...pic, drawings: [...pic.drawings, d] } },
  }
}

describe('a Trupp ⇄ Leitung link', () => {
  // F5: the actions of the render before the hose existed looked for it in that render's arrays
  it('a new hose finished on the crew marker links that crew, in the same gesture', () => {
    const f = fixture([crew], [])
    const gesture = f.useActions()
    f.draw(hose)
    expect(gesture.linkLineToAttachedTrupp('H', hose.endAttachment)).toBe(true)
    expect(f.crew()?.lineId).toBe('H')
    expect(f.line()?.truppId).toBe('C')
  })

  // review of #742: a hose drawn FROM the crew's marker is already coupled to it — the marker
  // stays where it stands, and the free end stays free
  it('a new hose that starts on the crew marker links the crew without moving the marker', () => {
    const f = fixture([crew], [])
    const gesture = f.useActions()
    const fromMarker: Drawing = { id: 'H', kind: 'line', coords: [[7, 47], [7.02, 47]], startAttachment: objectAttachment('M') }
    f.draw(fromMarker)
    expect(gesture.linkLineToAttachedTrupp('H', fromMarker.startAttachment)).toBe(true)
    expect(f.crew()?.lineId).toBe('H')
    expect(f.marker()?.coord).toEqual([7, 47])
    expect(f.line()?.endAttachment).toBeUndefined()
  })

  // review of #742: replay ignores `atemschutz.line.link`, so the stamped number rides a draw.edit
  it('the number a link stamps on a new hose is in replay', async () => {
    const f = fixture([{ ...crew, lineNo: 3 }], [])
    const gesture = f.useActions()
    f.draw(hose)
    gesture.linkLineToAttachedTrupp('H', hose.endAttachment)
    const { drawings } = await replayEmits({ entities: [marker], drawings: [hose] }, JSON.parse(JSON.stringify(f.emit.mock.calls)))
    expect(drawings.find((d) => d.id === 'H')).toMatchObject({ lineNo: 3, truppId: 'C' })
  })

  // F7: «Gehört zu Trupp» wrote both sides raw and laid no step, so ↶ took back an older act
  it('«Gehört zu Trupp» on an existing hose is one ↶ step over the crew and the hose', () => {
    const f = fixture([crew], [hose])
    expect(f.useActions().linkTruppLine('C', 'H')).toBe(true)
    expect(f.timeline.entries().past).toHaveLength(1)
    expect(f.timeline.peekUndo()?.domain).toBe('trupps')
    f.timeline.undo()
    expect(f.crew()?.lineId).toBeUndefined()
    expect(f.line()?.truppId).toBeUndefined()
    f.timeline.redo()
    expect(f.crew()?.lineId).toBe('H')
    expect(f.line()?.truppId).toBe('C')
  })

  it('…and a crew that claimed the same number gets it back with the same ↶', () => {
    const other: Trupp = { ...crew, id: 'D', name: 'Other', entityId: undefined, lineNo: 4, status: 'aktiv' }
    const f = fixture([{ ...crew, lineNo: 4 }, other], [hose])
    f.useActions().linkTruppLine('C', 'H')
    expect(f.crew('D')?.lineNo).toBeUndefined()
    expect(f.timeline.peekUndo()?.touches?.()).toEqual(expect.arrayContaining(['trupps:C', 'trupps:D']))
    f.timeline.undo()
    expect(f.crew('D')?.lineNo).toBe(4)
  })

  // F6: the form cleared the anchor outside its saved patch, so ↷ put the crew back on the old
  // hose, and ↶ did not give the hose its mirror back
  it('a hose-number change lets go of the hose, and ↶ / ↷ move crew and hose together', () => {
    const linked: Trupp = { ...crew, lineId: 'H', lineNo: 1 }
    const f = fixture([linked], [{ ...hose, lineNo: 1, truppId: 'C' }])
    f.useActions().editTrupp('C', truppFieldsOf(linked, { lineNo: 2 }))
    expect(f.crew()?.lineId).toBeUndefined()
    expect(f.line()?.truppId).toBeUndefined()
    expect(f.timeline.entries().past).toHaveLength(1)
    f.timeline.undo()
    expect(f.crew()).toMatchObject({ lineId: 'H', lineNo: 1 })
    expect(f.line()?.truppId).toBe('C')
    f.timeline.redo()
    expect(f.crew()).toMatchObject({ lineNo: 2 })
    expect(f.crew()?.lineId).toBeUndefined()
    expect(f.line()?.truppId).toBeUndefined()
  })
})
