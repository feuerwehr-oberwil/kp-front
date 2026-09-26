// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { emptySuche, storeyBereichId, sucheGroups, type SucheStack, type TruppHere } from './suche'
import { useSucheActions } from './useSucheActions'
import { useSucheTrupps } from './useSucheTrupps'
import { floorLabel } from './whiteboard'
import type { SucheDoc, Trupp } from '../types'

const stack: SucheStack = { key: 'k1', floors: [0, 1, 2], floorName: floorLabel }
const here: TruppHere[] = [{ id: 't4', label: 'Trupp 4', short: 'T4' }]
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't4', name: 'Muster', no: 4, entryPressureBar: 300, status: 'angemeldet', readings: [], auftrag: 'absuchen', ...over,
} as Trupp)

/** the real writer + the real observer over a live slice — what IncidentWorkspace mounts */
function mount(start: Trupp[]) {
  const out: { doc: SucheDoc; setTrupps: (t: Trupp[]) => void; actions?: ReturnType<typeof useSucheActions> } = { doc: emptySuche(), setTrupps: () => {} }
  function Harness() {
    const [doc, setDoc] = useState(emptySuche())
    const [trupps, setTrupps] = useState(start)
    const remote = useRef(false)
    out.doc = doc
    out.setTrupps = setTrupps
    const actions = useSucheActions({ suche: doc, setRaw: setDoc, canEdit: true, log: () => {}, emit: () => {}, floorName: floorLabel, stack: stack.key })
    out.actions = actions
    useSucheTrupps({ trupps, canEdit: true, actions, stack, placed: [], truppsHere: here, remoteRef: remote })
    return null
  }
  render(<Harness />)
  return out
}
const status = (doc: SucheDoc, id: string) => sucheGroups(doc, stack).flatMap((g) => g.units).find((u) => u.id === id)

describe('useSucheTrupps', () => {
  it('the FIRST «Absuchen» Trupp with a storey Ziel marks that storey — before any seed existed', () => {
    const h = mount([trupp({ ziel: 'EG' })])
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'aktiv', entryTime: '2026-09-23T19:36:00.000Z' })]))
    expect(status(h.doc, storeyBereichId(0, 'k1'))).toMatchObject({ status: 'inArbeit', trupp: 'Trupp 4', truppId: 't4' })
    // …and the storeys came into being with it
    expect(h.doc.bereiche.filter((b) => !b.name).map((b) => b.floor).sort()).toEqual([0, 1, 2])
  })

  it('a Trupp that never went in marks nothing', () => {
    const h = mount([trupp({})])
    act(() => h.setTrupps([trupp({ ziel: '1. OG Aula' })]))
    expect(h.doc.bereiche).toEqual([])
  })

  it('a new name creates the part; a changed Ziel releases the old area', () => {
    const h = mount([trupp({ ziel: '1. OG Aula' })])
    act(() => h.setTrupps([trupp({ ziel: '1. OG Aula', status: 'aktiv', entryTime: '2026-09-23T19:40:00.000Z' })]))
    const aula = h.doc.bereiche.find((b) => b.name === 'Aula')!
    expect(status(h.doc, aula.id)?.status).toBe('inArbeit')
    act(() => h.setTrupps([trupp({ ziel: '2. OG', status: 'aktiv', entryTime: '2026-09-23T19:40:00.000Z' })]))
    expect(status(h.doc, aula.id)?.status).toBe('offen')
    expect(status(h.doc, storeyBereichId(2, 'k1'))?.status).toBe('inArbeit')
  })

  it('a re-entry with the SAME Ziel is a new sortie and marks «in Arbeit» again', () => {
    const h = mount([trupp({ ziel: 'EG' })])
    const eg = storeyBereichId(0, 'k1')
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'aktiv', entryTime: '2026-09-23T19:36:00.000Z' })]))
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'raus', entryTime: '2026-09-23T19:36:00.000Z' })]))
    // out: the question stands on the row, and somebody answers «Nein» — the area is open again
    expect(status(h.doc, eg)?.status).toBe('inArbeit')
    act(() => { h.actions!.setStatus(eg, 'offen') })
    expect(status(h.doc, eg)?.status).toBe('offen')
    // re-entry, same Ziel, a new sortie
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'aktiv', entryTime: '2026-09-23T20:05:00.000Z' })]))
    expect(status(h.doc, eg)?.status).toBe('inArbeit')
  })

  it('removing the Trupp releases its area', () => {
    const h = mount([trupp({ ziel: 'EG' })])
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'aktiv', entryTime: '2026-09-23T19:36:00.000Z' })]))
    act(() => h.setTrupps([trupp({ ziel: 'EG', status: 'aktiv', entryTime: '2026-09-23T19:36:00.000Z', removedAt: '2026-09-23T19:50:00.000Z' })]))
    expect(status(h.doc, storeyBereichId(0, 'k1'))?.status).toBe('offen')
  })
})
