// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { emptySuche, personView, storeyBereichId, sucheSummary } from '../../lib/suche'
import { useSucheActions, type SucheLog } from '../../lib/useSucheActions'
import { floorLabel } from '../../lib/whiteboard'
import type { SucheDoc } from '../../types'
import { SuchePanel, type SuchePanelProps, type SucheTab } from './SuchePanel'

afterEach(cleanup)
const C = appConfig.copy.suche

/** The panel over a live slice and the real writer hook — what the dock and the phone sheet mount. */
function Harness({ initial = emptySuche(), canEdit = true, floors = [0, 1], log = vi.fn<SucheLog>(), onDoc, asks, focus, onExit }: {
  initial?: SucheDoc; canEdit?: boolean; floors?: number[]; log?: SucheLog; onDoc?: (d: SucheDoc) => void; asks?: string[]
  focus?: SuchePanelProps['focus']; onExit?: () => void
}) {
  const [doc, setDoc] = useState(initial)
  const [tab, setTab] = useState<SucheTab>('personen')
  const set = (d: SucheDoc) => { setDoc(d); onDoc?.(d) }
  const actions = useSucheActions({ suche: doc, setRaw: set, canEdit, log, emit: () => {}, floorName: floorLabel, stack: 'k1' })
  return (
    <SuchePanel doc={doc} floors={floors} floorName={floorLabel} stackKey="k1" asks={asks} canEdit={canEdit} actions={actions}
      trupps={[{ id: 't3', label: 'Trupp 3', short: 'T3 Muster' }]} placed={[{ truppId: 't3', floor: 1 }]}
      tab={tab} onTab={setTab} uebergabe={['Rettungsdienst', 'Sammelplatz']} focus={focus} onExit={onExit} />
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
    // ONE row, and it names the area the person was found in
    expect(last.personen[0].log.map((r) => r.op)).toEqual(['vermisst', 'gefunden'])
    expect(last.personen[0].log[1].bereichId).toBe(storeyBereichId(1, 'k1'))
  })

  it('shows every storey as an area with its progress, and sets a status in one tap', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }))
    const heads = screen.getAllByText(/^(EG|1\. OG)$/)
    expect(heads.map((h) => h.textContent)).toEqual(['1. OG', 'EG'])
    fireEvent.click(screen.getAllByText(C.ganzesGeschoss)[1]) // the EG's row
    fireEvent.click(screen.getByRole('button', { name: C.bereichStatus.abgesucht }))
    expect(last.bereiche.find((b) => b.id === storeyBereichId(0, 'k1'))?.log[0]).toMatchObject({ op: 'status', status: 'abgesucht', text: 'EG abgesucht' })
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

  it('«Trupp raus – abgesucht?» stands on the area\'s row, and only an answer writes', () => {
    let last: SucheDoc = emptySuche()
    const eg = storeyBereichId(0, 'k1')
    const start: SucheDoc = { personen: [], bereiche: [{ id: eg, floor: 0, stack: 'k1', createdAt: '', log: [
      { id: 'r1', op: 'status', status: 'inArbeit', trupp: 'Trupp 4', truppId: 't4', at: '2026-09-23T20:00:00.000Z', text: 'EG in Arbeit · Trupp 4' },
    ] }] }
    render(<Harness initial={start} asks={[eg]} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }))
    const ask = screen.getByRole('group', { name: 'Trupp 4 raus – abgesucht?' })
    expect(last).toEqual(emptySuche()) // nothing written for asking
    // the tab counts the open questions — it is where they are answered
    expect(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }).textContent).toContain('1?')
    fireEvent.click(within(ask).getByRole('button', { name: C.rausTeilweise }))
    // «Teilweise» is its own status (N14): it keeps the Trupp and is never the «offen» of an area
    // nobody touched
    expect(last.bereiche[0].log[last.bereiche[0].log.length - 1]).toMatchObject({ status: 'teilweise', trupp: 'Trupp 4', text: 'EG teilweise abgesucht · Trupp 4' })
  })

  it('«teilweise abgesucht» reads apart from «offen» on the list and counts as not done', () => {
    const eg = storeyBereichId(0, 'k1')
    const start: SucheDoc = { personen: [], bereiche: [{ id: eg, floor: 0, stack: 'k1', createdAt: '', log: [
      { id: 'r1', op: 'status', status: 'teilweise', trupp: 'Trupp 4', truppId: 't4', at: '2026-09-23T20:19:00.000Z', text: 'EG teilweise abgesucht · Trupp 4' },
    ] }] }
    render(<Harness initial={start} floors={[0]} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(C.tabBereiche) }))
    const row = screen.getByText(C.ganzesGeschoss).closest('button')!
    expect(row.getAttribute('data-tone')).toBe('part')
    expect(row.textContent).toContain(`${C.bereichStatus.teilweise} · T4`)
    expect(within(screen.getByText('EG').closest('section')!).getByText('0/1')).toBeTruthy()
  })

  it('a person is corrected and withdrawn from its card — both rows, both one step', () => {
    let last: SucheDoc = emptySuche()
    const start: SucheDoc = { personen: [{ id: 'p1', name: 'Tim Mustr', createdAt: '2026-09-23T20:08:00.000Z', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-23T20:08:00.000Z', text: 'Vermisst: Tim Mustr' },
    ] }], bereiche: [] }
    render(<Harness initial={start} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByText('Tim Mustr'))
    fireEvent.click(screen.getByRole('button', { name: C.korrigierenBtn }))
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Tim Muster' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitKorrigieren }))
    expect(personView(last.personen[0]).label).toBe('Tim Muster')
    // «Irrtümlich erfasst» asks first (N7) — and «Abbrechen» holds the focus: Enter keeps the person
    fireEvent.click(screen.getByRole('button', { name: C.irrtuemlichBtn }))
    expect(document.activeElement?.textContent).toBe(C.cancel)
    fireEvent.click(screen.getByRole('button', { name: C.cancel }))
    expect(personView(last.personen[0]).status).toBe('vermisst')
    fireEvent.click(screen.getByRole('button', { name: C.irrtuemlichBtn }))
    fireEvent.click(screen.getByRole('button', { name: C.irrtuemlichGruende[0] }))
    fireEvent.click(screen.getByRole('button', { name: C.whyQuellen[0] }))
    fireEvent.click(screen.getByRole('button', { name: C.submitIrrtuemlich }))
    expect(personView(last.personen[0])).toMatchObject({ status: 'irrtuemlich', missing: 0 })
    const row = last.personen[0].log[last.personen[0].log.length - 1]
    expect(row).toMatchObject({ op: 'irrtuemlich', grund: C.irrtuemlichGruende[0], quelle: C.whyQuellen[0],
      text: `Irrtümlich erfasst: Tim Muster · ${C.irrtuemlichGruende[0]} · Quelle ${C.whyQuellen[0]}` })
  })

  it('«Irrtümlich erfasst» stands apart from «Korrigieren», at the foot of the card', () => {
    const start: SucheDoc = { personen: [{ id: 'p1', name: 'Tim Muster', createdAt: '', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-23T20:08:00.000Z', text: 'Vermisst: Tim Muster' },
    ] }], bereiche: [] }
    render(<Harness initial={start} />)
    fireEvent.click(screen.getByText('Tim Muster'))
    const fix = screen.getByRole('button', { name: C.korrigierenBtn })
    const withdraw = screen.getByRole('button', { name: C.irrtuemlichBtn })
    expect(fix.parentElement).not.toBe(withdraw.parentElement)
  })

  it('«Entwarnen» asks why and who said so; nothing is written until it is confirmed', () => {
    let last: SucheDoc = emptySuche()
    const start: SucheDoc = { personen: [{ id: 'p1', name: 'Tim Muster', createdAt: '', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-23T20:08:00.000Z', text: 'Vermisst: Tim Muster' },
    ] }], bereiche: [] }
    render(<Harness initial={start} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByText('Tim Muster'))
    fireEvent.click(screen.getByRole('button', { name: C.entwarnenBtn }))
    expect(last).toEqual(emptySuche()) // opening the form writes nothing
    expect(document.activeElement?.textContent).toBe(C.cancel)
    fireEvent.change(screen.getByRole('textbox', { name: C.grund }), { target: { value: 'telefonisch zu Hause erreicht' } })
    fireEvent.change(screen.getByRole('textbox', { name: C.werSagt }), { target: { value: 'Hauswart' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitEntwarnen }))
    expect(personView(last.personen[0]).status).toBe('entwarnt')
    expect(last.personen[0].log[1].text).toBe('Entwarnung: Tim Muster · telefonisch zu Hause erreicht · Quelle Hauswart')
  })

  it('hosted as the «Fund melden» sheet it opens on the find and hands back when done (N17)', () => {
    let last: SucheDoc = emptySuche()
    const onExit = vi.fn()
    const start: SucheDoc = { personen: [{ id: 'p1', name: 'Tim Muster', floor: 1, createdAt: '', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-23T20:08:00.000Z', text: 'Vermisst: Tim Muster' },
    ] }], bereiche: [] }
    render(<Harness initial={start} onDoc={(d) => { last = d }} focus={{ fund: { truppId: 't3', floor: 1 }, nonce: 1 }} onExit={onExit} />)
    fireEvent.click(screen.getByRole('button', { name: /Tim Muster/ }))
    fireEvent.click(screen.getByRole('button', { name: C.submitGefunden }))
    expect(personView(last.personen[0])).toMatchObject({ status: 'gefunden', foundTrupp: 'Trupp 3' })
    // done is done: the host closes — no person card, no list left standing in the sheet
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('the ‹ of the «Fund melden» sheet closes it too, writing nothing', () => {
    const onExit = vi.fn()
    render(<Harness focus={{ fund: { truppId: 't3', floor: 1 }, nonce: 1 }} onExit={onExit} />)
    fireEvent.click(screen.getByRole('button', { name: C.back }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('reads only, and says so, where the session may not write', () => {
    render(<Harness canEdit={false} />)
    expect(screen.getByText(C.readOnlyNote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(C.addVermisst) })).toBeNull()
  })

  it('the phone\'s one line says who is missing and how far the search is', () => {
    expect(sucheSummary(2, { done: 5, total: 8 })).toBe('Suche · 2 vermisst · Bereiche 5/8')
    expect(sucheSummary(0, { done: 0, total: 0 })).toBe('Suche · niemand vermisst')
    // …and the open «abgesucht?» questions, where the sheet is only one line (N13)
    expect(sucheSummary(2, { done: 5, total: 8 }, 1)).toBe('Suche · 2 vermisst · Bereiche 5/8 · 1 Frage')
    expect(sucheSummary(2, { done: 5, total: 8 }, 3)).toBe('Suche · 2 vermisst · Bereiche 5/8 · 3 Fragen')
  })
})

const fillN = (tpl: string, n: number) => tpl.replace('{n}', String(n))
