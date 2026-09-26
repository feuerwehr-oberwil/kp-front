// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { emptySuche, shownBereiche, type TruppHere } from './suche'
import { useSucheActions } from './useSucheActions'
import { useSucheTrupps } from './useSucheTrupps'
import { floorLabel } from './whiteboard'
import type { SucheDoc, Trupp } from '../types'

const here: TruppHere[] = [{ id: 't4', label: 'Trupp 4', short: 'T4' }]
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't4', name: 'Muster', no: 4, entryPressureBar: 300, status: 'angemeldet', readings: [], auftrag: 'absuchen', ...over,
} as Trupp)

/** the real writer + the real observer over a live slice — what IncidentWorkspace mounts */
function mount(start: Trupp[], initial: SucheDoc = emptySuche()) {
  const out: { doc: SucheDoc; setTrupps: (t: Trupp[]) => void; actions?: ReturnType<typeof useSucheActions> } = { doc: initial, setTrupps: () => {} }
  function Harness() {
    const [doc, setDoc] = useState(initial)
    const [trupps, setTrupps] = useState(start)
    const remote = useRef(false)
    out.doc = doc
    out.setTrupps = setTrupps
    const actions = useSucheActions({ suche: doc, setRaw: setDoc, canEdit: true, log: () => {}, emit: () => {}, floorName: floorLabel })
    out.actions = actions
    useSucheTrupps({ trupps, canEdit: true, actions, floorName: floorLabel, truppsHere: here, remoteRef: remote })
    return null
  }
  render(<Harness />)
  return out
}
const place = (doc: SucheDoc, label: string) => shownBereiche(doc, floorLabel).find((u) => u.label === label)
const inAt = '2026-09-23T19:36:00.000Z'

describe('useSucheTrupps', () => {
  it('a Trupp going in on «Absuchen» marks the place its Ziel names — and creates nothing else (nothing preset)', () => {
    const h = mount([trupp({ ziel: 'Keller' })])
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'aktiv', entryTime: inAt })]))
    expect(place(h.doc, 'Keller')).toMatchObject({ status: 'inArbeit', trupp: 'Trupp 4', truppId: 't4' })
    // step 1 made every storey of the Gebäude an area here; now the Ziel is the one place there is
    expect(h.doc.bereiche.map((b) => b.name)).toEqual(['Keller'])
    expect(h.doc.bereiche[0]).not.toHaveProperty('floor')
  })

  it('a Ziel that names a place already on the list marks THAT place', () => {
    const start: SucheDoc = { personen: [], bereiche: [{ id: 'b1', name: 'Wohnung 2. OG links', createdAt: '', log: [] }] }
    const h = mount([trupp({ ziel: 'wohnung 2. og links' })], start)
    act(() => h.setTrupps([trupp({ ziel: 'wohnung 2. og links', status: 'aktiv', entryTime: inAt })]))
    expect(h.doc.bereiche).toHaveLength(1)
    expect(place(h.doc, 'Wohnung 2. OG links')?.status).toBe('inArbeit')
  })

  it('a Trupp that never went in marks nothing', () => {
    const h = mount([trupp({})])
    act(() => h.setTrupps([trupp({ ziel: 'Aula' })]))
    expect(h.doc.bereiche).toEqual([])
  })

  it('a changed Ziel releases the old place and marks the new one', () => {
    const h = mount([trupp({ ziel: 'Aula' })])
    act(() => h.setTrupps([trupp({ ziel: 'Aula', status: 'aktiv', entryTime: '2026-09-23T19:40:00.000Z' })]))
    expect(place(h.doc, 'Aula')?.status).toBe('inArbeit')
    act(() => h.setTrupps([trupp({ ziel: 'Dachstock', status: 'aktiv', entryTime: '2026-09-23T19:40:00.000Z' })]))
    expect(place(h.doc, 'Aula')?.status).toBe('offen')
    expect(place(h.doc, 'Dachstock')?.status).toBe('inArbeit')
  })

  it('a re-entry with the SAME Ziel is a new sortie and marks «in Arbeit» again', () => {
    const h = mount([trupp({ ziel: 'Keller' })])
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'aktiv', entryTime: inAt })]))
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'raus', entryTime: inAt })]))
    // out: the question stands on the row, and somebody answers «Nein» — the place is open again
    const id = place(h.doc, 'Keller')!.id
    expect(place(h.doc, 'Keller')?.status).toBe('inArbeit')
    act(() => { h.actions!.setStatus(id, 'offen') })
    expect(place(h.doc, 'Keller')?.status).toBe('offen')
    // re-entry, same Ziel, a new sortie
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'aktiv', entryTime: '2026-09-23T20:05:00.000Z' })]))
    expect(place(h.doc, 'Keller')?.status).toBe('inArbeit')
  })

  it('removing the Trupp releases its place', () => {
    const h = mount([trupp({ ziel: 'Keller' })])
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'aktiv', entryTime: inAt })]))
    act(() => h.setTrupps([trupp({ ziel: 'Keller', status: 'aktiv', entryTime: inAt, removedAt: '2026-09-23T19:50:00.000Z' })]))
    expect(place(h.doc, 'Keller')?.status).toBe('offen')
  })
})
