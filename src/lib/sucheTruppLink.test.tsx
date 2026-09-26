// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { pendingAsks, shownBereiche, sucheDropTarget, type TruppHere } from './suche'
import { createUndoTimeline } from './undoTimeline'
import { useSucheActions } from './useSucheActions'
import { useSucheTrupps } from './useSucheTrupps'
import { floorLabel } from './whiteboard'
import type { SucheDoc, Trupp } from '../types'

// A Trupp linked to a Suche place from the surface (owner 26.09.2026, owner-5: «I can't attach a
// Trupp to the Absuchen thing but only to the symbols») is the SAME act as «Wer sucht?» on the
// place's card: IncidentWorkspace · sucheLinkTrupp calls `assign`. These run the real writer and
// the real observer over a live slice and a live board, wired the way the workspace wires them.

const here: TruppHere[] = [{ id: 't4', label: 'Trupp 4', short: 'T4 Muster', status: 'aktiv' }]
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't4', name: 'Muster', no: 4, entryPressureBar: 300, status: 'aktiv', readings: [], auftrag: 'absuchen', entryTime: '2026-09-23T19:36:00.000Z', ...over,
} as Trupp)
const place = (id: string, name: string, log: SucheDoc['bereiche'][number]['log'] = []) => ({ id, name, createdAt: '2026-09-23T19:30:00.000Z', log })

function mount(start: Trupp[], initial: SucheDoc) {
  const timeline = createUndoTimeline()
  const out: { doc: SucheDoc; trupps: Trupp[]; setTrupps: (t: Trupp[]) => void; actions?: ReturnType<typeof useSucheActions>; timeline: typeof timeline } =
    { doc: initial, trupps: start, setTrupps: () => {}, timeline }
  function Harness() {
    const [doc, setDoc] = useState(initial)
    const [trupps, setTrupps] = useState(start)
    const remote = useRef(false)
    const own = useRef(new Set<string>())
    const live = useRef(trupps); live.current = trupps
    out.doc = doc
    out.trupps = trupps
    out.setTrupps = setTrupps
    const actions = useSucheActions({
      suche: doc, setRaw: setDoc, canEdit: true, log: () => {}, emit: () => {}, floorName: floorLabel,
      remember: (label, undo, redo, touches) => timeline.push({ domain: 'suche', label, undo, redo, touches }),
      trupps: {
        get: (id) => live.current.find((t) => t.id === id),
        set: (id, v) => { own.current.add(id); setTrupps((ts) => ts.map((t) => (t.id === id ? { ...t, ...v } : t))); return true },
      },
    })
    out.actions = actions
    useSucheTrupps({ trupps, canEdit: true, actions, floorName: floorLabel, truppsHere: here, remoteRef: remote, ownRef: own })
    return null
  }
  render(<Harness />)
  return out
}
const status = (doc: SucheDoc) => Object.fromEntries(shownBereiche(doc, floorLabel).map((b) => [b.label, [b.status, b.trupp].filter(Boolean).join(' · ')]))
const rows = (doc: SucheDoc) => doc.bereiche.flatMap((b) => b.log.map((r) => r.text))

describe('a Trupp linked to a Suche place (the marker on the pin, or «Wer sucht?»)', () => {
  const start: SucheDoc = { personen: [], bereiche: [
    place('b1', 'Garage', [{ id: 's1', at: '2026-09-23T19:37:00.000Z', op: 'status', status: 'inArbeit', trupp: 'Trupp 4', truppId: 't4', text: 'Garage in Arbeit · Trupp 4' }]),
    place('b2', 'Dachstock'),
  ] }

  it('sets the place «in Arbeit · Trupp 4», its Ziel reads the place — ONE step, and the observer adds nothing', () => {
    const h = mount([trupp({ ziel: 'Garage' })], start)
    act(() => { h.actions!.assign('b2', { label: 'Trupp 4', id: 't4' }) })
    expect(status(h.doc)).toEqual({ Garage: 'offen', Dachstock: 'inArbeit · Trupp 4' })
    expect(h.trupps[0]).toMatchObject({ ziel: 'Dachstock', auftrag: 'absuchen' })
    // the place's row and the release of the old one — nothing written a second time by the
    // observer reacting to the new Ziel (lib/useSucheTrupps · ownRef)
    expect(rows(h.doc)).toEqual(['Garage in Arbeit · Trupp 4', 'Garage offen', 'Dachstock in Arbeit · Trupp 4'])
    expect(h.timeline.entries().past).toHaveLength(1)
    expect(h.timeline.peekUndo()?.label).toBe('Dachstock in Arbeit · Trupp 4')
    // ONE ↶ takes the place, the released place AND the Ziel back
    act(() => { h.timeline.undo() })
    expect(status(h.doc)).toEqual({ Garage: 'inArbeit · Trupp 4', Dachstock: 'offen' })
    expect(h.trupps[0].ziel).toBe('Garage')
    expect(rows(h.doc)).toEqual(['Garage in Arbeit · Trupp 4'])
    // …and ↷ puts it all back
    act(() => { h.timeline.redo() })
    expect(status(h.doc)).toEqual({ Garage: 'offen', Dachstock: 'inArbeit · Trupp 4' })
    expect(h.trupps[0].ziel).toBe('Dachstock')
  })

  it('when the Trupp comes out, «Trupp 4 raus – abgesucht?» stands on THAT place', () => {
    const h = mount([trupp({ ziel: 'Garage' })], start)
    act(() => { h.actions!.assign('b2', { label: 'Trupp 4', id: 't4' }) })
    act(() => h.setTrupps([{ ...h.trupps[0], status: 'raus', exitTime: '2026-09-23T20:10:00.000Z' }]))
    const asks = pendingAsks(shownBereiche(h.doc, floorLabel), (id) => h.trupps.find((t) => t.id === id)?.status === 'raus')
    expect(asks.map((b) => b.label)).toEqual(['Dachstock'])
  })

  it('a Ziel under «Anderes» is the order itself and is never overwritten — the place is still searched', () => {
    const h = mount([trupp({ auftrag: 'anderes', ziel: 'Hauswart suchen' })], { personen: [], bereiche: [place('b2', 'Dachstock')] })
    act(() => { h.actions!.assign('b2', { label: 'Trupp 4', id: 't4' }) })
    expect(status(h.doc)).toEqual({ Dachstock: 'inArbeit · Trupp 4' })
    expect(h.trupps[0]).toMatchObject({ auftrag: 'anderes', ziel: 'Hauswart suchen' })
  })

  it('the same Trupp on the same place again writes nothing, and lays no step', () => {
    const h = mount([trupp({ ziel: 'Garage' })], start)
    act(() => { h.actions!.assign('b1', { label: 'Trupp 4', id: 't4' }) })
    expect(rows(h.doc)).toEqual(['Garage in Arbeit · Trupp 4'])
    expect(h.timeline.canUndo()).toBe(false)
  })
})

describe('sucheDropTarget — which pin a dropped marker lands on', () => {
  const pins = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 150, y: 100 }]
  it('the nearest pin within the reach, nothing beyond it', () => {
    expect(sucheDropTarget(pins, { x: 140, y: 110 }, 56)?.id).toBe('b')
    expect(sucheDropTarget(pins, { x: 90, y: 100 }, 56)?.id).toBe('a')
    expect(sucheDropTarget(pins, { x: 300, y: 300 }, 56)).toBeNull()
    expect(sucheDropTarget([], { x: 0, y: 0 }, 56)).toBeNull()
  })
})
