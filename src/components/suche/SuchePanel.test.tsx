// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { emptySuche, personView, sucheSummary } from '../../lib/suche'
import { useSucheActions, type SucheLog } from '../../lib/useSucheActions'
import { floorLabel } from '../../lib/whiteboard'
import type { SucheDoc } from '../../types'
import { SuchePanel, type SucheTab } from './SuchePanel'

afterEach(cleanup)
const C = appConfig.copy.suche

/** The panel over a live slice and the real writer hook — what the dock and the phone sheet mount. */
function Harness({ initial = emptySuche(), canEdit = true, floors = [0, 1], log = vi.fn<SucheLog>(), onDoc }: {
  initial?: SucheDoc; canEdit?: boolean; floors?: number[]; log?: SucheLog; onDoc?: (d: SucheDoc) => void
}) {
  const [doc, setDoc] = useState(initial)
  const [tab, setTab] = useState<SucheTab>('personen')
  const set = (d: SucheDoc) => { setDoc(d); onDoc?.(d) }
  const actions = useSucheActions({ suche: doc, set, setRaw: set, canEdit, log, emit: () => {}, floorName: floorLabel })
  return (
    <SuchePanel doc={doc} floors={floors} floorName={floorLabel} canEdit={canEdit} actions={actions}
      trupps={[{ id: 't3', label: 'Trupp 3', short: 'T3 Muster' }]} placed={[{ truppId: 't3', floor: 1 }]}
      tab={tab} onTab={setTab} uebergabe={['Rettungsdienst', 'Sammelplatz']} />
  )
}

describe('SuchePanel', () => {
  it('teaches what it is for while nobody is missing, and reports somebody in one form', () => {
    let last: SucheDoc = emptySuche()
    const log = vi.fn<SucheLog>()
    render(<Harness log={log} onDoc={(d) => { last = d }} />)
    expect(screen.getByText(C.emptyPersonen)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Tim Muster' } })
    fireEvent.click(screen.getByRole('button', { name: '1. OG' }))
    fireEvent.change(screen.getByLabelText(C.woGenau), { target: { value: 'Technikraum' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitVermisst }))
    expect(last.personen).toHaveLength(1)
    expect(personView(last.personen[0])).toMatchObject({ label: 'Tim Muster', floor: 1, status: 'vermisst' })
    // …one Verlauf row, in its own words, linked to the person
    expect(log).toHaveBeenCalledWith('search', 'Vermisst: Tim Muster · zuletzt 1. OG Technikraum', undefined, undefined, undefined,
      expect.objectContaining({ suche: { personId: last.personen[0].id } }))
    // back on the list, with the red count on the tab
    expect(screen.getByText('Tim Muster')).toBeTruthy()
  })

  it('«Gefunden…» pre-selects the Trupp on that storey and takes the place over', () => {
    let last: SucheDoc = emptySuche()
    const start: SucheDoc = { personen: [{ id: 'p1', name: 'Tim Muster', floor: 1, wo: 'Technikraum', createdAt: '2026-09-23T20:08:00.000Z', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-23T20:08:00.000Z', text: 'Vermisst: Tim Muster' },
    ] }], bereiche: [] }
    render(<Harness initial={start} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByText('Tim Muster'))
    fireEvent.click(screen.getByRole('button', { name: C.gefundenBtn }))
    expect(screen.getByRole('button', { name: 'T3 Muster' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Rettungsdienst' }))
    fireEvent.click(screen.getByRole('button', { name: C.submitGefunden }))
    const v = personView(last.personen[0])
    expect(v).toMatchObject({ status: 'uebergeben', foundTrupp: 'Trupp 3', foundFloor: 1, foundWo: 'Technikraum', an: 'Rettungsdienst' })
    // the storey's area now carries the find
    expect(last.bereiche.find((b) => b.id === 'sbg1')?.log.map((r) => r.op)).toEqual(['fund'])
  })

  it('shows every storey as an area with its progress, and sets a status in one tap', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }))
    const heads = screen.getAllByText(/^(EG|1\. OG)$/)
    expect(heads.map((h) => h.textContent)).toEqual(['1. OG', 'EG'])
    fireEvent.click(screen.getAllByText(C.ganzesGeschoss)[1]) // the EG's row
    fireEvent.click(screen.getByRole('button', { name: C.bereichStatus.abgesucht }))
    expect(last.bereiche.find((b) => b.id === 'sbg0')?.log[0]).toMatchObject({ op: 'status', status: 'abgesucht', text: 'EG abgesucht' })
  })

  it('splits a storey by names; the storey counts its parts plus the rest', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }))
    fireEvent.click(screen.getAllByText(C.ganzesGeschoss)[0]) // the 1. OG
    fireEvent.click(screen.getByRole('button', { name: C.teilen }))
    fireEvent.click(screen.getByRole('button', { name: 'Trakt 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trakt 2' }))
    fireEvent.click(screen.getByRole('button', { name: fillN(C.teilenSubmit, 2) }))
    expect(last.bereiche.filter((b) => b.floor === 1 && b.name).map((b) => b.name)).toEqual(['Trakt 1', 'Trakt 2'])
    const group = screen.getByText('1. OG').closest('section')!
    expect(within(group).getByText('0/3')).toBeTruthy()
  })

  it('a group is counted with the stepper, and only the one button reports it', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Gruppe Werkstatt' } })
    fireEvent.click(screen.getByRole('button', { name: C.gruppe }))
    const more = within(screen.getByRole('group', { name: C.anzahl })).getByRole('button', { name: appConfig.copy.stepper.more })
    // a real press: the step fires on pointerdown, and the browser's click follows it
    const press = () => { fireEvent.pointerDown(more, { button: 0 }); fireEvent.pointerUp(window); fireEvent.click(more) }
    press()
    press()
    // ⚠️ the stepper's buttons are no submit: nothing reported yet (it once was, at 3)
    expect(last.personen).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: C.submitVermisst }))
    expect(personView(last.personen[0])).toMatchObject({ group: true, count: 4, missing: 4 })
  })

  it('reads only, and says so, where the session may not write', () => {
    render(<Harness canEdit={false} />)
    expect(screen.getByText(C.readOnlyNote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(C.addVermisst) })).toBeNull()
  })

  it('the phone\'s one line says who is missing and how far the search is', () => {
    expect(sucheSummary(2, { done: 5, total: 8 })).toBe('Suche · 2 vermisst · Bereiche 5/8')
    expect(sucheSummary(0, { done: 0, total: 0 })).toBe('Suche · niemand vermisst')
  })
})

const fillN = (tpl: string, n: number) => tpl.replace('{n}', String(n))
