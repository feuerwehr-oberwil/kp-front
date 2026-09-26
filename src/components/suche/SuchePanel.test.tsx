// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { emptySuche, personView, shownBereiche } from '../../lib/suche'
import { createUndoTimeline } from '../../lib/undoTimeline'
import { useSucheActions, type SucheLog } from '../../lib/useSucheActions'
import { floorLabel } from '../../lib/whiteboard'
import type { SucheDoc, SuchePoint, SucheRow } from '../../types'
import { SuchePanel, type SuchePanelProps } from './SuchePanel'
import { SucheCard } from './SucheCard'

afterEach(cleanup)
const C = appConfig.copy.suche
const T = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`
const row = (id: string, op: SucheRow['op'], at: string, text: string, more: Partial<SucheRow> = {}): SucheRow => ({ id, op, at: T(at), text, ...more })

/** The panel over a live slice, the real writer hook and a real undo timeline — what the card and
 *  the «Fund melden» sheet mount. */
function Harness({ initial = emptySuche(), canEdit = true, log = vi.fn<SucheLog>(), onDoc, asks, focus, onExit, onUndoable, timeline, card, pick, onShow }: {
  initial?: SucheDoc; canEdit?: boolean; log?: SucheLog; onDoc?: (d: SucheDoc) => void; asks?: string[]
  focus?: SuchePanelProps['focus']; onExit?: () => void; onUndoable?: SuchePanelProps['onUndoable']
  timeline?: ReturnType<typeof createUndoTimeline>; card?: boolean; pick?: SuchePanelProps['pick']; onShow?: SuchePanelProps['onShow']
}) {
  const [doc, setDoc] = useState(initial)
  const set = (d: SucheDoc) => { setDoc(d); onDoc?.(d) }
  const actions = useSucheActions({
    suche: doc, setRaw: set, canEdit, log, emit: () => {}, floorName: floorLabel,
    remember: timeline ? (label, undo, redo) => timeline.push({ domain: 'suche', label, undo, redo }) : undefined,
  })
  const props: SuchePanelProps = {
    doc, floorName: floorLabel, asks, canEdit, actions,
    trupps: [{ id: 't1', label: 'Trupp 1', short: 'T1 Muster', status: 'drin' }, { id: 't3', label: 'Trupp 3', short: 'T3 Beispiel', status: 'drin' }, { id: 't5', label: 'Trupp 5', short: 'T5 Probe', status: 'raus' }],
    uebergabe: ['Rettungsdienst', 'Sammelplatz'], focus, onExit, onUndoable: onUndoable ?? (() => {}), pick, onShow,
  }
  return card ? <SucheCard {...props} onClose={() => {}} /> : <SuchePanel {...props} />
}

const person = (id: string, name: string, more: Partial<SucheDoc['personen'][number]> = {}, at = '20:08') => ({
  id, name, createdAt: T(at), log: [row(`r-${id}`, 'vermisst', at, `Vermisst: ${name}`)], ...more,
})
const place = (id: string, name: string, log: SucheRow[] = [], at = '20:00') => ({ id, name, createdAt: T(at), log })
const sections = () => screen.getAllByRole('region').map((s) => s.getAttribute('aria-label')).filter((l) => l !== C.title)

describe('SuchePanel · one list by place (design «F», 26.09.2026)', () => {
  it('is EMPTY until somebody enters something — one sentence, two equal buttons, nothing preset', () => {
    let last: SucheDoc | null = null
    render(<Harness card onDoc={(d) => { last = d }} />)
    expect(screen.getByText(C.emptyTitle)).toBeTruthy()
    expect(screen.getByText(C.emptySub)).toBeTruthy()
    const add = [screen.getByRole('button', { name: new RegExp(C.addVermisst) }), screen.getByRole('button', { name: new RegExp(C.addBereich) })]
    // the two doors are the same button: a sweep with nobody missing is not the lesser case
    expect(add[0].className).toBe(add[1].className)
    expect(add.every((b) => !b.hasAttribute('data-primary'))).toBe(true)
    // no tabs, no storey rows, no Gebäude | Karte switch — and opening wrote nothing
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText(/ganzes Geschoss|übriges Geschoss/)).toBeNull()
    expect(last).toBeNull()
  })

  it('«＋ Vermisst» with a NEW place creates the person AND the place — one step, one ↶ takes both', () => {
    let last: SucheDoc = emptySuche()
    const timeline = createUndoTimeline()
    const log = vi.fn<SucheLog>()
    const start: SucheDoc = { personen: [], bereiche: [place('b1', 'Keller')] }
    render(<Harness card initial={start} log={log} timeline={timeline} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Muster Tim' } })
    // the places already entered are offered, so person and place point at one place
    expect(within(screen.getByRole('group', { name: C.schonErfasst })).getByRole('button', { name: 'Keller' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(C.woZuletzt), { target: { value: 'Wohnung 2. OG links' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitVermisst }))
    expect(last.bereiche.map((b) => b.name)).toEqual(['Keller', 'Wohnung 2. OG links'])
    expect(last.personen[0]).toMatchObject({ name: 'Muster Tim', bereichId: last.bereiche[1].id })
    expect(log).toHaveBeenCalledWith('search', 'Vermisst: Muster Tim · zuletzt Wohnung 2. OG links', undefined, undefined, undefined,
      expect.objectContaining({ suche: { personId: last.personen[0].id } }))
    // back on the list: the new place sorts first (somebody is missing there), with a red edge
    expect(sections()).toEqual(['Wohnung 2. OG links', 'Keller'])
    expect(screen.getByRole('region', { name: 'Wohnung 2. OG links' }).hasAttribute('data-hot')).toBe(true)
    expect(screen.getByText(fillTemplate(C.vermisstChip, { n: 1 }) + ' · ' + fillTemplate(C.headAbgesucht, { done: 0, total: 2 }))).toBeTruthy()
    // ONE step: its ↶ takes the person and the new place
    act(() => { timeline.undo() })
    expect(last).toEqual(start)
    expect(timeline.canUndo()).toBe(false)
  })

  it('a place picked from the chips is the SAME place, however it is spelt', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness initial={{ personen: [], bereiche: [place('b1', 'Keller')] }} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    fireEvent.click(screen.getByRole('button', { name: 'Keller' }))
    expect((screen.getByLabelText(C.woZuletzt) as HTMLInputElement).value).toBe('Keller')
    fireEvent.click(screen.getByRole('button', { name: C.submitVermisst }))
    expect(last.bereiche).toHaveLength(1)
    expect(last.personen[0].bereichId).toBe('b1')
  })

  it('the count stays optional: one person asks nothing, «mehrere?» opens the stepper, which never submits', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    expect(screen.queryByRole('group', { name: C.anzahl })).toBeNull()
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Gruppe Werkstatt' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.mehrere) }))
    const more = within(screen.getByRole('group', { name: C.anzahl })).getByRole('button', { name: appConfig.copy.stepper.more })
    // a real press: the step fires on pointerdown, and the browser's click follows it
    const press = () => { fireEvent.pointerDown(more, { button: 0 }); fireEvent.pointerUp(window); fireEvent.click(more) }
    press()
    press()
    // ⚠️ the stepper's buttons are no submit: nothing reported yet (it once was, at 3)
    expect(last.personen).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: C.submitVermisst }))
    expect(personView(last.personen[0])).toMatchObject({ group: true, count: 4, missing: 4 })
    // …and with no place given, nobody invents one: «Ort unbekannt», at the top
    expect(last.bereiche).toEqual([])
    expect(screen.getByText(C.ortUnbekannt)).toBeTruthy()
  })

  it('the circle IS the button: one tap abgesucht (with the house toast to take it back), again → offen', () => {
    let last: SucheDoc = emptySuche()
    const timeline = createUndoTimeline()
    const onUndoable = vi.fn<(text: string, takeBack: () => void) => void>()
    render(<Harness initial={{ personen: [], bereiche: [place('b1', 'Treppenhaus')] }} timeline={timeline} onUndoable={onUndoable} onDoc={(d) => { last = d }} />)
    const tick = screen.getByRole('button', { name: fillTemplate(C.tickAbgesucht, { name: 'Treppenhaus' }) })
    fireEvent.click(tick)
    expect(shownBereiche(last, floorLabel)[0].status).toBe('abgesucht')
    expect(last.bereiche[0].log.slice(-1)[0]).toMatchObject({ op: 'status', status: 'abgesucht', text: 'Treppenhaus abgesucht' })
    expect(onUndoable).toHaveBeenCalledWith(fillTemplate(C.toastAbgesucht, { name: 'Treppenhaus' }), expect.any(Function))
    // the toast's «Rückgängig» takes it back — and the ↶ has nothing left to take (never twice)
    act(() => onUndoable.mock.calls[0][1]())
    expect(shownBereiche(last, floorLabel)[0].status).toBe('offen')
    expect(timeline.canUndo()).toBe(false)
    // tapped twice: abgesucht, then back to offen — a row each time
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.tickAbgesucht, { name: 'Treppenhaus' }) }))
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.tickOffen, { name: 'Treppenhaus' }) }))
    expect(shownBereiche(last, floorLabel)[0].status).toBe('offen')
    expect(last.bereiche[0].log.map((r) => r.status)).toEqual(['abgesucht', 'offen'])
  })

  it('«Gefunden» on the person\'s line books the find in ONE tap — with the place and the Trupp searching it', () => {
    let last: SucheDoc = emptySuche()
    const onUndoable = vi.fn<(text: string, takeBack: () => void) => void>()
    const start: SucheDoc = {
      bereiche: [place('b1', 'Wohnung 2. OG links', [row('s1', 'status', '20:05', 'Wohnung 2. OG links in Arbeit · Trupp 1', { status: 'inArbeit', trupp: 'Trupp 1', truppId: 't1' })])],
      personen: [person('p1', 'Muster Tim', { bereichId: 'b1', wo: 'Wohnung 2. OG links' }), person('p2', 'Gruppe Werkstatt', { count: 6 })],
    }
    render(<Harness initial={start} onUndoable={onUndoable} onDoc={(d) => { last = d }} />)
    const line = screen.getByRole('region', { name: 'Wohnung 2. OG links' })
    expect(within(line).getByText(fillTemplate(C.sucht, { trupp: 'T1' }))).toBeTruthy()
    fireEvent.click(within(line).getByRole('button', { name: fillTemplate(C.toastGefunden, { name: 'Muster Tim' }) }))
    expect(personView(last.personen[0])).toMatchObject({ status: 'gefunden', foundTrupp: 'Trupp 1' })
    expect(last.personen[0].log[1]).toMatchObject({ op: 'gefunden', bereichId: 'b1', text: 'Gefunden: Muster Tim · Wohnung 2. OG links · Trupp 1' })
    expect(onUndoable).toHaveBeenLastCalledWith(fillTemplate(C.toastGefunden, { name: 'Muster Tim' }), expect.any(Function))
    // a group gets «＋1», one at a time
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.plusOneLabel, { name: 'Gruppe Werkstatt' }) }))
    expect(personView(last.personen[1])).toMatchObject({ found: 1, missing: 5 })
    // …and the toast takes a find back
    act(() => onUndoable.mock.calls[1][1]())
    expect(personView(last.personen[1])).toMatchObject({ found: 0, missing: 6 })
  })

  it('orders the list: «Ort unbekannt» on top, missing first, entry order, abgesucht-and-nobody-missing quiet at the end', () => {
    const start: SucheDoc = {
      bereiche: [
        place('b1', 'Treppenhaus', [row('s1', 'status', '20:40', 'Treppenhaus abgesucht · Trupp 2', { status: 'abgesucht', trupp: 'Trupp 2', truppId: 't2' })]),
        place('b2', 'Keller'),
        place('b3', 'Wohnung 2. OG links'),
        place('b4', 'Dachstock'),
      ],
      personen: [
        person('p1', 'Muster Tim', { bereichId: 'b3' }),
        person('p2', 'Hauswart', {}, '20:20'),
        { id: 'p3', name: 'Beispiel Anna', createdAt: T('20:10'), log: [row('r3', 'vermisst', '20:10', 'Vermisst'), row('r4', 'gefunden', '20:31', 'Gefunden', { bereichId: 'b1', trupp: 'Trupp 2' })], bereichId: 'b2' },
      ],
    }
    render(<Harness initial={start} />)
    expect(sections()).toEqual([C.ortUnbekannt, 'Wohnung 2. OG links', 'Keller', 'Dachstock', 'Treppenhaus'])
    const done = screen.getByRole('region', { name: 'Treppenhaus' })
    expect(done.hasAttribute('data-quiet')).toBe(true)
    // she stands where she was found, done
    expect(within(done).getByText('Beispiel Anna')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: C.ortUnbekannt })).getByText('Hauswart')).toBeTruthy()
  })

  it('a step-1 document (storeys, `sbg:` ids) renders as places — and never shows a storey nobody touched', () => {
    const start: SucheDoc = {
      bereiche: [
        { id: 'sbg:k1:2', floor: 2, stack: 'k1', createdAt: T('19:36'), log: [] },
        { id: 'sbg:k1:1', floor: 1, stack: 'k1', createdAt: T('19:36'), log: [row('s1', 'status', '20:10', '1. OG in Arbeit · Trupp 1', { status: 'inArbeit', trupp: 'Trupp 1', truppId: 't1' })] },
        { id: 'sb9', floor: 1, name: 'Trakt 3', stack: 'k1', ohneRest: true, createdAt: T('19:40'), log: [row('g1', 'geteilt', '19:40', '1. OG geteilt: Trakt 3')] },
      ],
      personen: [person('p1', 'Tim Muster', { floor: 1, wo: 'Trakt 3 Büro' })],
    }
    render(<Harness initial={start} />)
    expect(sections()).toEqual(['1. OG Trakt 3', '1. OG'])
    expect(within(screen.getByRole('region', { name: '1. OG Trakt 3' })).getByText('Tim Muster')).toBeTruthy()
    // a storey row has no name of its own: its card offers no «Umbenennen»
    fireEvent.click(within(screen.getByRole('region', { name: '1. OG' })).getByText('1. OG'))
    expect(screen.queryByRole('button', { name: C.umbenennen })).toBeNull()
    expect(screen.getByText('1. OG in Arbeit · Trupp 1')).toBeTruthy()
  })

  it('«＋ Bereich»: Wo? and who searches it, «noch niemand» by default — a Trupp already out is not offered', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addBereich) }))
    const who = screen.getByRole('group', { name: C.werSucht })
    expect(within(who).getByRole('button', { name: C.nochNiemand }).getAttribute('aria-pressed')).toBe('true')
    expect(within(who).queryByRole('button', { name: 'T5 Probe' })).toBeNull()
    expect((screen.getByRole('button', { name: C.submitBereich }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(C.bereichWo), { target: { value: 'Dachstock' } })
    fireEvent.click(within(who).getByRole('button', { name: 'T3 Beispiel' }))
    fireEvent.click(screen.getByRole('button', { name: C.submitBereich }))
    expect(shownBereiche(last, floorLabel)).toEqual([expect.objectContaining({ label: 'Dachstock', status: 'inArbeit', trupp: 'Trupp 3', truppId: 't3' })])
    expect(screen.getByRole('region', { name: 'Dachstock' })).toBeTruthy()
  })

  it('«Trupp raus – abgesucht?» stands on the place\'s row, and only an answer writes', () => {
    let last: SucheDoc | null = null
    const start: SucheDoc = { personen: [], bereiche: [place('b1', 'Keller', [row('s1', 'status', '20:00', 'Keller in Arbeit · Trupp 4', { status: 'inArbeit', trupp: 'Trupp 4', truppId: 't4' })])] }
    render(<Harness initial={start} asks={['b1']} onDoc={(d) => { last = d }} />)
    const ask = screen.getByRole('group', { name: 'Trupp 4 raus – abgesucht?' })
    expect(last).toBeNull() // nothing written for asking
    fireEvent.click(within(ask).getByRole('button', { name: C.rausTeilweise }))
    // «Teilweise» is its own status (N14): it keeps the Trupp and is never «offen»
    expect(last!.bereiche[0].log.slice(-1)[0]).toMatchObject({ status: 'teilweise', trupp: 'Trupp 4', text: 'Keller teilweise abgesucht · Trupp 4' })
    const tick = screen.getByRole('button', { name: fillTemplate(C.tickAbgesucht, { name: 'Keller' }) })
    expect(tick.getAttribute('data-tone')).toBe('part')
  })

  it('a place\'s own card: the status choices, the Trupp, «Fund», a new name — and never a name two places share', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness initial={{ personen: [], bereiche: [place('b1', 'Keller'), place('b2', 'Dachstock')] }} onDoc={(d) => { last = d }} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'Keller' })).getByText('Keller'))
    fireEvent.click(screen.getByRole('button', { name: C.bereichStatus.inArbeit }))
    fireEvent.click(screen.getByRole('button', { name: 'T1 Muster' }))
    expect(shownBereiche(last, floorLabel)[0]).toMatchObject({ status: 'inArbeit', trupp: 'Trupp 1' })
    fireEvent.click(screen.getByRole('button', { name: C.umbenennen }))
    const input = screen.getByLabelText(C.bereichWo)
    fireEvent.change(input, { target: { value: 'dachstock' } })
    expect((screen.getByRole('button', { name: C.umbenennenSubmit }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Keller Nord' } })
    fireEvent.click(screen.getByRole('button', { name: C.umbenennenSubmit }))
    expect(last.bereiche[0].name).toBe('Keller Nord')
  })

  it('a person is corrected and withdrawn from its card — both rows, both one step', () => {
    let last: SucheDoc = emptySuche()
    render(<Harness initial={{ personen: [person('p1', 'Tim Mustr')], bereiche: [] }} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByText('Tim Mustr'))
    fireEvent.click(screen.getByRole('button', { name: C.korrigierenBtn }))
    fireEvent.change(screen.getByLabelText(C.wer), { target: { value: 'Tim Muster' } })
    fireEvent.change(screen.getByLabelText(C.woZuletzt), { target: { value: 'Keller' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitKorrigieren }))
    expect(personView(last.personen[0])).toMatchObject({ label: 'Tim Muster', wo: 'Keller' })
    expect(last.bereiche.map((b) => b.name)).toEqual(['Keller'])
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
    expect(last.personen[0].log.slice(-1)[0]).toMatchObject({ op: 'irrtuemlich', grund: C.irrtuemlichGruende[0], quelle: C.whyQuellen[0] })
  })

  it('«Irrtümlich erfasst» stands apart from «Korrigieren», at the foot of the card', () => {
    render(<Harness initial={{ personen: [person('p1', 'Tim Muster')], bereiche: [] }} />)
    fireEvent.click(screen.getByText('Tim Muster'))
    const fix = screen.getByRole('button', { name: C.korrigierenBtn })
    const withdraw = screen.getByRole('button', { name: C.irrtuemlichBtn })
    expect(fix.parentElement).not.toBe(withdraw.parentElement)
  })

  it('«Entwarnen» asks why and who said so; nothing is written until it is confirmed', () => {
    let last: SucheDoc | null = null
    render(<Harness initial={{ personen: [person('p1', 'Tim Muster')], bereiche: [] }} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByText('Tim Muster'))
    fireEvent.click(screen.getByRole('button', { name: C.entwarnenBtn }))
    expect(last).toBeNull() // opening the form writes nothing
    expect(document.activeElement?.textContent).toBe(C.cancel)
    fireEvent.change(screen.getByRole('textbox', { name: C.grund }), { target: { value: 'telefonisch zu Hause erreicht' } })
    fireEvent.change(screen.getByRole('textbox', { name: C.werSagt }), { target: { value: 'Hauswart' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitEntwarnen }))
    expect(personView(last!.personen[0]).status).toBe('entwarnt')
    expect(last!.personen[0].log[1].text).toBe('Entwarnung: Tim Muster · telefonisch zu Hause erreicht · Quelle Hauswart')
  })

  it('hosted as the «Fund melden» sheet it opens on the find at the Trupp\'s place and hands back when done (N17)', () => {
    let last: SucheDoc = emptySuche()
    const onExit = vi.fn()
    const start: SucheDoc = { personen: [person('p1', 'Tim Muster', { wo: 'Dachstock' }), person('p2', 'Klasse 4b', { count: 5 })], bereiche: [place('b1', 'Keller')] }
    render(<Harness initial={start} onDoc={(d) => { last = d }} focus={{ fund: { truppId: 't3', bereichId: 'b1' }, nonce: 1 }} onExit={onExit} />)
    fireEvent.click(screen.getByRole('button', { name: /Klasse 4b/ }))
    // ⚠️ the place is the Trupp's, and a group counts from ONE (F7) — never «zuletzt gesehen», never everybody
    expect((screen.getByLabelText(C.wo) as HTMLInputElement).value).toBe('Keller')
    expect(screen.getByRole('button', { name: 'T3 Beispiel' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: C.submitGefunden }))
    expect(personView(last.personen[1])).toMatchObject({ found: 1, missing: 4, foundTrupp: 'Trupp 3' })
    expect(last.personen[1].log[1].bereichId).toBe('b1')
    // done is done: the host closes — no person card, no list left standing in the sheet
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('the ‹ of the «Fund melden» sheet closes it too, writing nothing', () => {
    const onExit = vi.fn()
    render(<Harness focus={{ fund: { truppId: 't3' }, nonce: 1 }} onExit={onExit} />)
    fireEvent.click(screen.getByRole('button', { name: C.back }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('reads only, and says so, where the session may not write — the circles are there, inert', () => {
    render(<Harness canEdit={false} initial={{ personen: [person('p1', 'Tim Muster', { wo: 'Keller' })], bereiche: [place('b1', 'Keller')] }} />)
    expect(screen.getByText(C.readOnlyNote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(C.addVermisst) })).toBeNull()
    expect(screen.queryByRole('button', { name: fillTemplate(C.toastGefunden, { name: 'Tim Muster' }) })).toBeNull()
    expect((screen.getByRole('button', { name: fillTemplate(C.tickAbgesucht, { name: 'Keller' }) }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the card\'s head says who is missing and how far the sweep is — nobody missing says nothing about it', () => {
    const { unmount } = render(<Harness card initial={{ personen: [], bereiche: [place('b1', 'Scheune', [row('s1', 'status', '20:10', 'Scheune abgesucht', { status: 'abgesucht' })]), place('b2', 'Wohnhaus')] }} />)
    expect(screen.getByText(fillTemplate(C.headAbgesucht, { done: 1, total: 2 }))).toBeTruthy()
    expect(screen.queryByText(/vermisst/)).toBeNull()
    unmount()
    render(<Harness card initial={{ personen: [person('p1', 'A')], bereiche: [] }} />)
    expect(screen.getByText(fillTemplate(C.vermisstChip, { n: 1 })).hasAttribute('data-hot')).toBe(true)
  })

  it('«📍 Auf Karte setzen» in «＋ Bereich» hands the surface over and gets the tap back; the pin is born with the place — one step', () => {
    let last: SucheDoc = emptySuche()
    const timeline = createUndoTimeline()
    let done: ((p: SuchePoint) => void) | null = null
    const start = vi.fn((_name: string, cb: (p: SuchePoint) => void) => { done = cb })
    render(<Harness timeline={timeline} pick={{ surface: 'karte', start }} onDoc={(d) => { last = d }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addBereich) }))
    fireEvent.change(screen.getByLabelText(C.bereichWo), { target: { value: 'Scheune' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.pickKarte) }))
    expect(start).toHaveBeenCalledWith('Scheune', expect.any(Function))
    // the tap on the surface comes back; the form still holds its words
    act(() => done!({ coord: [7.6, 47.5] }))
    expect(screen.getByRole('button', { name: new RegExp(C.pickSet) }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText(C.bereichWo) as HTMLInputElement).value).toBe('Scheune')
    expect(last.bereiche).toEqual([]) // nothing written before «Erfassen»
    fireEvent.click(screen.getByRole('button', { name: C.submitBereich }))
    expect(last.bereiche[0]).toMatchObject({ name: 'Scheune', point: { coord: [7.6, 47.5] } })
    act(() => { timeline.undo() })
    expect(last.bereiche).toEqual([])
  })

  it('a place\'s card puts it on the surface, moves it and takes it off — each an ordinary step; «📍» on its row shows it', () => {
    let last: SucheDoc = emptySuche()
    const onShow = vi.fn()
    let done: ((p: SuchePoint) => void) | null = null
    const pick = { surface: 'plan' as const, start: (_n: string, cb: (p: SuchePoint) => void) => { done = cb } }
    render(<Harness initial={{ personen: [], bereiche: [place('b1', 'Keller')] }} pick={pick} onShow={onShow} onDoc={(d) => { last = d }} />)
    // no position yet: no «📍» on the row
    expect(screen.queryByRole('button', { name: fillTemplate(C.pinShow, { name: 'Keller' }) })).toBeNull()
    fireEvent.click(within(screen.getByRole('region', { name: 'Keller' })).getByText('Keller'))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.pickPlan) }))
    act(() => done!({ planId: 'gebaeude', x: 0.5, y: 0.4, floor: 1 }))
    expect(last.bereiche[0].point).toEqual({ planId: 'gebaeude', x: 0.5, y: 0.4, floor: 1 })
    expect(last.bereiche[0].log.slice(-1)[0]).toMatchObject({ op: 'ort', text: 'Keller auf dem Plan gesetzt' })
    fireEvent.click(screen.getByRole('button', { name: C.pickRemove }))
    expect(last.bereiche[0]).not.toHaveProperty('point')
    // back on the list with a position: «📍» brings it into view
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.pickPlan) }))
    act(() => done!({ planId: 'gebaeude', x: 0.2, y: 0.3, floor: 0 }))
    fireEvent.click(screen.getByRole('button', { name: C.back }))
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.pinShow, { name: 'Keller' }) }))
    expect(onShow).toHaveBeenCalledWith({ planId: 'gebaeude', x: 0.2, y: 0.3, floor: 0 })
  })

  it('«＋ Vermisst» at a place that stands already offers no second pin', () => {
    render(<Harness initial={{ personen: [], bereiche: [{ ...place('b1', 'Keller'), point: { coord: [7.6, 47.5] } }] }} pick={{ surface: 'karte', start: vi.fn() }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(C.addVermisst) }))
    expect(screen.getByRole('button', { name: new RegExp(C.pickKarte) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keller' }))
    expect(screen.queryByRole('button', { name: new RegExp(C.pickKarte) })).toBeNull()
    expect(screen.getByText(C.pickAlready)).toBeTruthy()
  })
})
