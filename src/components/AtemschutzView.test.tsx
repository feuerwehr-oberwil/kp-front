// @vitest-environment jsdom
// The 29.08. card rework, as it stands after the same-day revision: the contact clock folds
// its timing rows and the Verlauf footer previews the latest event and expands the log — both
// OPEN-ONLY (showing never logs, never counts as Kontakt). The Druck stepper is back inline
// (a Druckmeldung must never cost an opening tap); its ± only stages a pending value and the
// explicit «Bestätigen» commits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import { useIsPhone } from '../lib/useIsPhone'
import s from './Atemschutz.module.css'
import { appConfig } from '../config/appConfig'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import type { AttendanceState, Trupp } from '../types'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})

const az = appConfig.copy.atemschutz
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// one Trupp in the field, contact fresh (no alarm, so nothing scrolls/flashes on mount),
// with an entry + a pressure reading in its log
const aktivTrupp = (): Trupp => ({
  id: 'tr1', name: 'Steiner', members: ['Huber'],
  entryPressureBar: 300, entryTime: iso(10 * 60_000),
  lastContactTime: iso(2 * 60_000),
  lastPressureBar: 240, lastPressureTime: iso(4 * 60_000), lowestBar: 240,
  status: 'aktiv',
  readings: [
    { t: iso(10 * 60_000), bar: 300, kind: 'entry' },
    { t: iso(4 * 60_000), bar: 240, kind: 'pressure' },
  ],
})

const noop = () => {}
const propsFor = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => ({
    trupps: [aktivTrupp()], truppColors: { tr1: '#e8392b' }, canEdit: true,
    personnel: [], attendance: {} as AttendanceState,
    muted: false, onToggleMuted: noop,
    createTrupp: noop, placeTrupp: noop, placeTargets: [],
    markerOptions: () => [], adoptMarker: noop, focusTruppOnPlan: noop,
    recordContact: vi.fn(), recordPressure: vi.fn(), setTruppStatus: noop,
    editTrupp: noop, reactivateTrupp: noop, deleteTrupp: noop, restoreTrupp: noop,
    leitungOptions: () => [], showTruppLine: noop, truppsWithLine: new Set<string>(),
    pickTruppLine: noop, unlinkTruppLine: noop,
    ...over,
})
vi.mock('../lib/useIsPhone', () => ({ useIsPhone: vi.fn(() => false) }))

const mount = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => {
  const props = propsFor(over)
  render(<AtemschutzView {...props} />)
  return props
}

/** Name a Gruppenführer by hand in the open Trupp form — the roster is empty in these tests, so
 *  «Name eingeben» is the only door (TruppTeam · teamTypeName). */
const typeGuest = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: az.teamTypeName }))
  fireEvent.change(screen.getByLabelText(az.typeName), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: az.teamAdd }))
}

describe('the inline Druckmeldung', () => {
  it('offers ± immediately and commits only after a changed value is confirmed', () => {
    const props = mount()
    const step = atemschutzDoctrine().pressureStep
    const down = screen.getByLabelText(az.pressureDown.replace('{step}', String(step)))
    expect(screen.queryByRole('button', { name: az.pressureConfirm })).toBeNull()
    fireEvent.pointerDown(down)
    expect(props.recordPressure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: az.pressureConfirm }))
    expect(props.recordPressure).toHaveBeenCalledWith('tr1', 240 - step)
  })

  it('✕ throws away a pending pressure without hiding the immediate controls', () => {
    const props = mount()
    const step = atemschutzDoctrine().pressureStep
    fireEvent.pointerDown(screen.getByLabelText(az.pressureDown.replace('{step}', String(step))))
    fireEvent.click(screen.getByRole('button', { name: az.cancel }))
    expect(props.recordPressure).not.toHaveBeenCalled()
    expect(screen.getByLabelText(az.pressureDown.replace('{step}', String(step)))).toBeTruthy()
    expect(screen.queryByRole('button', { name: az.pressureConfirm })).toBeNull()
  })
})

/* The timing rows used to hide behind a tap on the clock itself — an affordance findable only by
 * knowing that five grey characters at the band's edge meant «tap me». They are the head of the
 * Verlauf now, behind a word, and the band went back to being a display. */
describe('the contact times (the head of the Verlauf)', () => {
  it('folds the timing rows out of the Verlauf — and the band is no longer a control', () => {
    const props = mount()
    expect(screen.queryByRole('button', { name: new RegExp(az.clockOk) })).toBeNull()
    expect(screen.queryByText(az.lastContactAt)).toBeNull() // collapsed by default
    const row = screen.getByRole('button', { name: new RegExp(az.verlauf) })
    fireEvent.click(row)
    expect(screen.getByText(az.lastContactAt)).toBeTruthy()
    expect(screen.getByText(az.nextContactDue)).toBeTruthy()
    expect(props.recordContact).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(screen.queryByText(az.lastContactAt)).toBeNull()
  })
})

/* The three things the card says about a STATE rather than a tier. Each of them was reachable
 * only in code for a while after the card redesign — the band's tier ladder had swallowed the
 * lifecycle word — and each is a fact a viewer, who has no action bar to read it off, would
 * otherwise get from a 5px border colour alone. */
describe('the state a tier cannot say', () => {
  it('names «Rückzug» beside the crew, where the band is still saying «Kontakt ok»', () => {
    mount({ trupps: [{ ...aktivTrupp(), status: 'rueckzug' }], canEdit: false })
    expect(screen.getByText(az.clockOk)).toBeTruthy()           // the tier, unchanged
    expect(screen.getByText(az.status.rueckzug)).toBeTruthy()   // …and the fact it cannot carry
  })

  it('gives a Trupp that is out its break clock, not an «ok» about a clock nobody watches', () => {
    mount({ trupps: [{ ...aktivTrupp(), status: 'raus', exitTime: iso(5 * 60_000) }] })
    expect(screen.getByText(az.status.raus)).toBeTruthy()
    expect(screen.getByText(az.outFor)).toBeTruthy()
    expect(screen.queryByText(az.clockOk)).toBeNull()
    expect(screen.queryByText(az.sinceContact)).toBeNull()
  })

  it('keeps «Einrücken» explained on a Trupp under Atemschutz — and only there', () => {
    mount({ trupps: [{ ...aktivTrupp(), status: 'angemeldet' }] })
    expect(screen.getByText(az.preEntryHint)).toBeTruthy()
    expect(screen.getByText(az.bandPreEntry)).toBeTruthy()
  })
})

describe('the Verlauf footer (the removed «Draussen: hh:mm» line, generalised)', () => {
  it('previews the LATEST event with its bar, and expands the full log in place', () => {
    mount()
    const row = screen.getByRole('button', { name: new RegExp(`${az.verlauf}.*${az.readingKind.pressure}`) })
    expect(row.textContent).toContain('240 bar')
    expect(row.textContent).not.toContain('2 Einträge')
    // the older entry row is behind the fold until the footer is tapped
    expect(screen.queryByText(az.readingKind.entry)).toBeNull()
    fireEvent.click(row)
    expect(screen.getByText(az.readingKind.entry)).toBeTruthy()
  })
})

describe('pointing to a Trupp', () => {
  it('replays the whole-card highlight when the same notification is tapped again', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const one = propsFor({ focus: { id: 'tr1', nonce: 1 } })
    const view = render(<AtemschutzView {...one} />)
    expect(scroll).toHaveBeenCalledTimes(1)
    view.rerender(<AtemschutzView {...one} focus={{ id: 'tr1', nonce: 2 }} />)
    expect(scroll).toHaveBeenCalledTimes(2)
    scroll.mockRestore()
  })

  it('opens «Auftrag offen» directly on a highlighted Auftrag field', () => {
    mount({ trupps: [{ ...aktivTrupp(), auftrag: undefined }] })
    fireEvent.click(screen.getByRole('button', { name: az.auftragOpen }))
    const art = screen.getByText(az.auftragLabel).closest('div')
    expect(art?.classList.contains(s.formFlash)).toBe(true)
  })
})

// «Tafel pur» — the board handed to somebody's own phone through an Atemschutz-Link. The rule
// worth pinning is the one that keeps it honest: nothing on it may point at a surface that
// session cannot reach, and the one fact it otherwise could not say — WHICH Einsatz — is said.
describe('the handed-over board (lite)', () => {
  const lite = { subtitle: 'Brand · Hauptstrasse 12, Oberwil' }

  it('names the Einsatz instead of the generic subtitle', () => {
    mount({ lite })
    expect(screen.getByText(lite.subtitle)).toBeTruthy()
    expect(screen.queryByText(az.subtitle)).toBeNull()
  })

  it('drops Platzieren, Leitung and the order menu — and keeps Kontakt and Bearbeiten', async () => {
    mount({ lite, onOrder: noop, trupps: [aktivTrupp(), { ...aktivTrupp(), id: 'tr2', name: 'Meier' }] })
    expect(screen.queryByRole('button', { name: az.orderLabel })).toBeNull()
    // …and no «Abmelden» (02.09.): the link owns no login on this phone, and the button that
    // stood beside the bell ended the phone's own one (lib/linkMode).
    expect(screen.queryByRole('button', { name: appConfig.copy.incidentSwitcher.logout })).toBeNull()
    expect(screen.getAllByRole('button', { name: az.actContact }).length).toBe(2)
    // the secondary controls are one ⋯ per card now — the rule about what it may offer is the same
    expect(screen.getAllByRole('button', { name: az.cardMenu }).length).toBe(2)
    for (const trigger of screen.getAllByRole('button', { name: az.cardMenu })) {
      fireEvent.click(trigger)
      expect(await screen.findByRole('menuitem', { name: az.edit })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: az.place })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: az.linePick })).toBeNull()
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    }
  })

  it('offers «Überwachung abgeben» only where a door was handed in', () => {
    mount()
    expect(screen.queryByRole('button', { name: az.shareLink })).toBeNull()
    cleanup()
    const share = vi.fn()
    mount({ onShareLink: share })
    fireEvent.click(screen.getByRole('button', { name: az.shareLink }))
    expect(share).toHaveBeenCalled()
  })

  // the button's whole «on» state: a link exists. Nothing else — a device counter was dropped.
  it('says a link is live rather than claiming what the press would do', () => {
    mount({ onShareLink: noop, shareLinkActive: true })
    expect(screen.getByRole('button', { name: az.shareLinkOn })).toBeTruthy()
  })
})

// The same board on a PHONE: one tab per Trupp in a strip, one Trupp filling the screen, and a
// tap on a tab is what decides which — not a scroll.
describe('the handed-over board on a phone (focus mode)', () => {
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })
  it('shows a tab per Trupp and exactly one card, and a tab picks its Trupp', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ lite: { subtitle: 'Brand · Hauptstrasse 12' }, trupps: [aktivTrupp(), { ...aktivTrupp(), id: 'tr2', name: 'Meier' }] })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(document.querySelectorAll(`.${s.card}`)).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: /Meier/ }))
    expect(document.querySelector(`.${s.card}`)?.textContent).toContain('Meier')
    // the strip's own «+ Trupp» is the door; no second one in the header
    expect(screen.getAllByRole('button', { name: az.newTrupp })).toHaveLength(1)
  })

  it('opens the Trupp form as two steps: the roster first, Druck and Auftrag behind «Weiter»', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ lite: { subtitle: 'Brand' }, trupps: [aktivTrupp()], createTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByText(new RegExp(az.wizardWho))).toBeTruthy()
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    // the steps walk freely — an empty roster still passes «Weiter»…
    fireEvent.click(screen.getByRole('button', { name: az.wizardNext }))
    expect(screen.getByText(new RegExp(az.wizardWhat))).toBeTruthy()
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    // …only the final submit is gated on a valid Trupp — `aria-disabled`, not the native
    // attribute, so a blocked tap still reaches attemptSubmit (which must not submit) and can
    // explain itself instead of the browser silently swallowing the click (field feedback, 02.09.)
    const submitBtn = screen.getByRole('button', { name: az.start })
    expect(submitBtn.getAttribute('aria-disabled')).toBe('true')
    // the roster is still empty, so the blocked tap walks back to step 1 (where that lives) —
    // never a step 2 stuck on «Speichern» with nothing to say why (field feedback, 02.09.)
    fireEvent.click(submitBtn)
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByText(new RegExp(az.wizardWho))).toBeTruthy()
  })

  // ⚠️ NO second card for this board (03.09.). It had one — `cardBig`, with its own condensed
  // header and its own flattened clock — and a phone-only arrangement of a safety card is a
  // second thing to keep in step with the first. The card the phone gets here is the card the
  // tablet grid and the row list get; what makes it fit is that the card itself got denser.
  it('uses the same card as every other board — same seven zones, in the same order', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ lite: { subtitle: 'Brand · Hauptstrasse 12' }, trupps: [aktivTrupp()] })
    const card = document.querySelector(`.${s.card}`)!
    // ⚠️ the whole zone list, in order, and NOTHING besides — that is the invariant the grid's
    // `subgrid` alignment rests on, and it is what a phone-only arrangement would break first.
    // Asserting «.cardHead exists» proves nothing: it exists on every card at every width.
    // the FIRST class of each child: the block also carries its tier, which is not the point here
    expect([...card.children].map((c) => c.className.trim().split(/\s+/)[0])).toEqual([
      s.cardHead, s.kenn, s.block, s.noteZone, s.actZone, s.plinth, s.vfoot,
    ])
    // Kontakt is still an in-card control, not a pinned screen-edge bar
    expect(card.querySelector(`.${s.kontaktBtn}`)).toBeTruthy()
    // the header's own row now carries just the Einsatz title (see the bottom-rail test below
    // for the dropped kicker and the relocated bell/«+ Trupp»)
    expect(document.querySelector(`.${s.headRow}`)).toBeTruthy()
  })

  // Maintainer correction (mock 03, 03.09.): the header sheds its kicker entirely, and the chip
  // strip + «+ Trupp» move into a bottom rail in the thumb zone — «status where the eyes land,
  // actions where the thumb lives». The card above stays top-aligned. A second review put the
  // bell BACK in the header (an earlier pass had tried it in the rail too) — only chips + the
  // compact «+» belong down there.
  it('drops the header kicker and moves the strip + «+ Trupp» into a bottom rail — the bell stays put', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ lite: { subtitle: 'Brand · Hauptstrasse 12' }, trupps: [aktivTrupp(), { ...aktivTrupp(), id: 'tr2', name: 'Meier' }] })
    // the fixed «Atemschutzüberwachung» kicker is gone — only the Einsatz's own name remains
    expect(screen.queryByText(az.title)).toBeNull()
    expect(screen.getByText('Brand · Hauptstrasse 12')).toBeTruthy()
    const rail = document.querySelector(`.${s.bottomRail}`)
    expect(rail).toBeTruthy()
    // the strip (its tabs, unchanged) now lives INSIDE the rail, not above the card
    expect(rail?.querySelector(`.${s.strip}`)).toBeTruthy()
    expect(rail?.querySelectorAll(`.${s.tab}`).length).toBe(2)
    // the bell stays in the header's own action group — NOT in the rail
    expect(document.querySelector(`.${s.headActs} .${s.muteBtn}`)).toBeTruthy()
    expect(rail?.querySelector(`.${s.muteBtn}`)).toBeNull()
    // «+ Trupp» is a compact icon button at the rail's end, not its own full-width chip
    const addBtn = screen.getByRole('button', { name: az.newTrupp })
    expect(rail?.contains(addBtn)).toBe(true)
    expect(addBtn.classList.contains(s.tab)).toBe(false)
  })
})

/* ── Trupps ohne Atemschutz — «Sektionen» (decided 03.09.) ────────────────────────────────────
 * One board, two sections, and — since the card redesign — ONE footprint: the same row, the same
 * card, the same tap to open. What keeps the PA safety signal undiluted is not a second, lighter
 * layout but the card's own restraint, so that is what these tests pin: no clock, no Druck, no
 * Kontakt, and never an alarm colour. */
describe('the board with Trupps that are not under Atemschutz', () => {
  // ⚠️ restored here rather than at the end of the one phone test below: a failure before that
  // line would otherwise leave every later test in this block running in phone mode.
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })
  const plainTrupp = (): Trupp => ({
    id: 'tr9', kind: 'einfach', name: 'Gerber', members: ['Stalder'],
    auftrag: 'sichern', ziel: 'Zufahrt Hauptstrasse', funkkanal: 1,
    entryPressureBar: 0, entryTime: iso(20 * 60_000), lastContactTime: '', status: 'aktiv',
  })

  it('leaves an all-Atemschutz board exactly as it was — no headings, no second half', () => {
    mount()
    expect(screen.queryByText(az.sectionAtemschutz)).toBeNull()
    expect(screen.queryByText(az.sectionPlain)).toBeNull()
    expect(document.querySelector(`.${s.cardPlain}`)).toBeNull()
  })

  it('splits into «Atemschutz» + «Weitere Trupps» and gives both halves the SAME card', () => {
    mount({ trupps: [aktivTrupp(), plainTrupp()], truppColors: { tr1: '#e8392b', tr9: '#e2920a' } })
    expect(screen.getByText(az.sectionAtemschutz)).toBeTruthy()
    expect(screen.getByText(az.sectionPlain)).toBeTruthy()
    expect(screen.getByText(az.sectionPlainHint)).toBeTruthy()
    const cards = [...document.querySelectorAll(`.${s.card}`)]
    expect(cards).toHaveLength(2)
    const plain = cards.find((c) => c.textContent?.includes('Gerber'))!
    // same shell — and NONE of the monitoring vocabulary: no clock, no Druck, no Kontakt
    expect(plain.classList.contains(s.cardPlain)).toBe(true)
    expect(plain.querySelector(`.${s.kontaktBtn}`)).toBeNull()
    expect(plain.textContent).not.toContain('bar')
    expect(screen.getAllByRole('button', { name: az.actContact })).toHaveLength(1) // the PA card's
  })

  /* ⚠️ The seam Bastian asked for by name (03.09.): on a phone the two halves must have the EXACT
   * same footprint. A work squad drawn at a different height in the same scroll teaches the eye
   * that these are two kinds of object, when the whole point of the section head is that they are
   * one board — and it made the half with no clock and no Druck the half that took the most
   * screen. Same row, same tap, same way back. */
  it('gives a work squad the same row and the same opening tap on a phone', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp(), plainTrupp()], truppColors: { tr1: '#e8392b', tr9: '#e2920a' } })
    const rows = [...document.querySelectorAll(`.${s.trow}`)]
    expect(rows).toHaveLength(2)
    expect(document.querySelector(`.${s.card}`)).toBeNull() // nothing open yet
    fireEvent.click(rows.find((r) => r.textContent?.includes('Gerber'))!)
    const card = document.querySelector(`.${s.card}`)!
    expect(card.textContent).toContain('Gerber')
    expect(card.classList.contains(s.cardPlain)).toBe(true)
    // …and back, through the same control the Atemschutz half uses
    fireEvent.click(screen.getByRole('button', { name: az.collapse }))
    expect(document.querySelector(`.${s.card}`)).toBeNull()
  })

  it('says so when the Atemschutz half is empty rather than leaving a bare heading', () => {
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' } })
    expect(screen.getByText(az.sectionAtemschutzEmpty)).toBeTruthy()
    // the one card on the board is the work squad's, and it is the plain one
    expect(document.querySelectorAll(`.${s.card}`)).toHaveLength(1)
    expect(document.querySelectorAll(`.${s.cardPlain}`)).toHaveLength(1)
  })

  it('offers the one lifecycle step its state actually has — and no Rückzug it cannot take', () => {
    const setTruppStatus = vi.fn()
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' }, setTruppStatus })
    expect(screen.queryByRole('button', { name: az.actEnter })).toBeNull() // it is already in
    // Rückzug lowers the turn-back pressure (alarmBarFor) and there is no cylinder to lower it on
    expect(screen.queryByRole('button', { name: az.actRueckzug })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.actExit }))
    expect(setTruppStatus).toHaveBeenCalledWith('tr9', 'raus')
  })

  /* ⚠️ Same ⋯ as every other card, and every entry a WORD. These used to be glyphs on the row
   * itself — a pen, a footprint, a bin — on the argument that a Trupp with nothing to open must
   * keep its controls in reach. It has something to open (its Verlauf), and a footprint that
   * means «platzieren» is exactly the knowledge that is gone after six months without practice. */
  it('puts bearbeiten · platzieren · entfernen behind the same ⋯ as every other card', async () => {
    const deleteTrupp = vi.fn()
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' }, deleteTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.cardMenu }))
    for (const label of [az.edit, az.place]) {
      expect(await screen.findByRole('menuitem', { name: label })).toBeTruthy()
    }
    fireEvent.click(await screen.findByRole('menuitem', { name: az.remove }))
    expect(deleteTrupp).toHaveBeenCalledWith('tr9')
  })

  // The handed-over Tafel operates the Atemschutzüberwachung and nothing else — that is what the
  // QR promises and what the link's backend allowlist permits.
  it('hides plain Trupps entirely on the handed-over board, and offers no way to create one', () => {
    mount({ lite: { subtitle: 'Brand' }, trupps: [aktivTrupp(), plainTrupp()], truppColors: { tr1: '#e8392b', tr9: '#e2920a' } })
    expect(screen.queryByText('Gerber')).toBeNull()
    expect(document.querySelector(`.${s.cardPlain}`)).toBeNull()
    expect(screen.queryByText(az.sectionPlain)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByText(az.kindLabel)).toBeNull()
  })

  it('asks «Art des Trupps» once, on creation only — the kind is fixed afterwards', async () => {
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' } })
    fireEvent.click(screen.getByRole('button', { name: az.cardMenu }))
    fireEvent.click(await screen.findByRole('menuitem', { name: az.edit }))
    expect(screen.queryByText(az.kindLabel)).toBeNull()
    // …and editing one never asks for a cylinder it does not have
    expect(screen.queryByText(az.editPressureLabel)).toBeNull()
    cleanup()
    mount()
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
  })

  it('creates a Trupp «ohne Atemschutz» with the kind stamped and no Eingangsdruck', () => {
    const createTrupp = vi.fn()
    mount({ createTrupp, personnel: [], trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    // the Druck field is there for Atemschutz…
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    // …and gone the moment it is not
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    typeGuest('Gerber Urs')
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).toHaveBeenCalledTimes(1)
    const made = createTrupp.mock.calls[0][0] as Trupp
    expect(made.kind).toBe('einfach')
    expect(made.entryPressureBar).toBe(0)
  })

  /* ── The Auftrag vocabulary follows the kind (03.09.) ──────────────────────────────────────
   * A Verkehrstrupp was being offered «Löschen» — the PA list, on a card that is read at a
   * glance. Each kind now has its own six words (config · atemschutz.auftrag / .auftragEinfach),
   * and the tiles swap with the «Art des Trupps» answer above them. */
  it('offers the Auftrag list belonging to the chosen Art des Trupps', () => {
    mount({ trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    const tiles = () => within(screen.getByRole('group', { name: az.auftragLabel }))
      .getAllByRole('button').map((b) => b.textContent)
    expect(tiles()).toEqual(['Retten', 'Löschen', 'Absuchen', 'Sichern', 'Erkunden', 'Anderes'])
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    expect(tiles()).toEqual(['Verkehr', 'Sanität', 'Wasserversorgung', 'Sichern', 'Bereitstellung', 'Anderes'])
    expect(tiles()).not.toContain('Löschen')
  })

  /* ⚠️ …but only the OFFER is narrowed. Every Trupp recorded before 03.09. carries a PA id, and
   * a kind can be mis-picked — the label resolver searches BOTH lists (lib/report ·
   * truppAuftragLabel), so the chip says the word rather than going blank or, worse, offering
   * «Auftrag offen» over an Auftrag that is set. An incident is a legal record. */
  it('renders an Auftrag stored from the OTHER kind’s list, both ways round', () => {
    mount({
      trupps: [{ ...aktivTrupp(), auftrag: 'verkehr' }, { ...plainTrupp(), auftrag: 'loeschen' }],
      truppColors: { tr1: '#e8392b', tr9: '#e2920a' },
    })
    expect(screen.getByText('Verkehr')).toBeTruthy()   // PA card wearing a non-PA id
    expect(screen.getByText('Löschen')).toBeTruthy()   // plain row wearing a PA id
    expect(screen.queryByRole('button', { name: az.auftragOpen })).toBeNull()
  })

  // «Anderes» is the escape hatch on BOTH lists — it is the same shared id — so it has to keep
  // demanding the word that says what the order actually was.
  it.each([['atemschutz', az.kindAtemschutz], ['einfach', az.kindPlain]])(
    'holds the save until «Anderes» has a Ziel (%s)', (_kind, kindLabel) => {
      const createTrupp = vi.fn()
      mount({ createTrupp, trupps: [] })
      fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(kindLabel) }))
      typeGuest('Gerber Urs')
      fireEvent.click(within(screen.getByRole('group', { name: az.auftragLabel })).getByText('Anderes'))
      fireEvent.click(screen.getByRole('button', { name: az.start }))
      expect(createTrupp).not.toHaveBeenCalled()
      fireEvent.change(screen.getByLabelText(az.zielLabel), { target: { value: 'Zufahrt sperren' } })
      fireEvent.click(screen.getByRole('button', { name: az.start }))
      expect(createTrupp).toHaveBeenCalledTimes(1)
    })

  // ⚠️ A default is never STAMPED: absent means «unter Atemschutz» (types · TruppKind), so a
  // fresh PA Trupp has to look exactly like every record written before 03.09.
  it('writes no kind at all for a Trupp under Atemschutz', () => {
    const createTrupp = vi.fn()
    mount({ createTrupp, trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    typeGuest('Meier Thomas')
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect('kind' in (createTrupp.mock.calls[0][0] as object)).toBe(false)
  })
})

/* ── The two-step form on ANY phone (03.09.) ──────────────────────────────────────────────────
 * The wizard was the handed-over board's own layout; the main board's phone view had the same
 * fold and now shares it. What differs outside the link: step 2 additionally carries the «Art des
 * Trupps» tiles at its top plus Leitung und Farbe. Every Art of Trupp walks the same two steps. */
describe('the Trupp form on the main board’s phone layout', () => {
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })

  it('walks two steps and puts Leitung and Farbe on step 2 (they are not on the link’s)', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByText(new RegExp(az.wizardWho))).toBeTruthy()
    expect(screen.queryByText(az.lineNoLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.wizardNext }))
    expect(screen.getByText(new RegExp(az.wizardWhat))).toBeTruthy()
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    expect(screen.getByText(az.lineNoLabel)).toBeTruthy()
    expect(screen.getByText(az.colorLabel)).toBeTruthy()
  })

  /* ⚠️ «Art des Trupps» belongs ABOVE THE FIELDS IT GOVERNS, and every one of those (Druck,
   * Auftrag, Kanal, Ziel) is on step 2 — so on the phone the chooser leads step 2 and step 1 is
   * the Mannschaft alone (03.09.). The one thing the Art does not govern is who is in the Trupp. */
  it('leads step 2 with the Art des Trupps chooser and leaves step 1 the Mannschaft alone', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
    expect(screen.queryByText(az.kindLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.wizardNext }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.queryByText(az.sectionTeam)).toBeNull()
  })

  it('a tablet keeps the single screen — the wizard is for 375px, not for touch', () => {
    mount({ trupps: [aktivTrupp()] }) // useIsPhone false
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByRole('button', { name: az.wizardNext })).toBeNull()
    expect(screen.getByText(az.pressureLabel)).toBeTruthy() // everything is already there
    // …and there the chooser is still FIRST and spans the form, above the two columns it governs
    const body = document.querySelector(`.${s.modalBody}`)
    expect(body?.firstElementChild?.className).toContain(s.formColWide)
    expect(body?.firstElementChild?.textContent).toContain(az.kindLabel)
  })

  /* ⚠️ Reversed on 03.09. This test used to pin «wizard off for a Trupp without Atemschutz».
   * That made the form RESTRUCTURE itself under the thumb that had just tapped «Ohne Atemschutz»,
   * which is the jarring part, not the length of step 2. The tap now only adds and drops the
   * Druck row directly beneath the tiles — ordinary form behaviour — and never moves the step or
   * touches step 1. */
  it('keeps the two steps for a Trupp without Atemschutz, with a step 2 that has no Druck', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: az.wizardNext }))
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    // the step itself is unchanged by the tap: same caption, same chooser, same rest of the step
    expect(screen.getByText(new RegExp(az.wizardWhat))).toBeTruthy()
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.getByText(az.funkkanalSection)).toBeTruthy()
    expect(screen.getByText(az.zielLabel)).toBeTruthy()
    // …minus the one field a Verkehrstrupp has no cylinder for
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    // and step 1 is untouched — walking back finds the Mannschaft where it was left
    fireEvent.click(screen.getByRole('button', { name: az.wizardBack }))
    expect(screen.getByText(new RegExp(az.wizardWho))).toBeTruthy()
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  /* The walk-back keys off the wizard alone, so a plain Trupp gets the same «Speichern» that
   * points at the missing Gruppenführer instead of sitting there doing nothing (02.09.). */
  it('walks a plain Trupp back to step 1 when the Gruppenführer is missing', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ trupps: [aktivTrupp()], createTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: az.wizardNext }))
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByText(new RegExp(az.wizardWho))).toBeTruthy()
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  /* ONE placeholder for every Auftrag (03.09.): «z. B. 2OG links» proposed a storey to a
   * Verkehrstrupp, so the generic sentence is now the only one. */
  it('uses the same Auftrag/Ziel placeholder whichever Auftrag is picked', () => {
    mount({ trupps: [aktivTrupp()] }) // tablet: one screen, everything is on it
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    const ziel = () => screen.getByPlaceholderText(az.zielPlaceholder)
    expect(ziel()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: az.auftragLabels.anderes }))
    expect(ziel()).toBeTruthy()
  })
})
