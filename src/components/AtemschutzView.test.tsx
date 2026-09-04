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
import { fillTemplate } from '../lib/format'
import type { AttendanceState, Trupp, TruppReading } from '../types'

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
// the doctrine the form starts a fresh cylinder at — the number a closed «Luft & Funk» prints
const dz = atemschutzDoctrine()
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

/* The lifecycle row stopped being a segmented strip of equal cells on 04.09.: it is `auto` + `1fr`
 * (see `.actions`), so which button is loud and which is quiet is decided by the ORDER in the
 * markup — quiet first. A refactor that reorders these buttons silently swaps their weights, and
 * nothing on screen would say so. */
describe('the lifecycle row: quiet button first', () => {
  it('puts «Raus melden» before the decision beside it, on both in-field states', () => {
    for (const status of ['aktiv', 'rueckzug'] as const) {
      cleanup()
      mount({ trupps: [{ ...aktivTrupp(), status }] })
      const labels = [...document.querySelectorAll(`.${s.actions} .${s.actBtn}`)].map((b) => b.textContent)
      expect(labels).toEqual([az.actExit, status === 'aktiv' ? az.actRueckzug : az.actContinue])
    }
  })

  it('leaves the pre-entry row led by «Nicht eingesetzt», with «Einrücken» taking the room', () => {
    mount({ trupps: [{ ...aktivTrupp(), status: 'angemeldet' }] })
    const labels = [...document.querySelectorAll(`.${s.actions} .${s.actBtn}`)].map((b) => b.textContent)
    expect(labels).toEqual([az.actNotDeployed, az.actEnter])
  })
})

/* A closed Einsatz is a record, not a situation. A Trupp that was never reported out kept
 * accumulating Einsatzzeit through the night, so the Akte opened the next morning claimed a crew
 * had been inside for eleven hours — and the überfällig alarm went with it (that half is App's,
 * see `azMonitoring`). Frozen, every clock reads what it read when the Einsatz ended. */
describe('an abgeschlossener Einsatz (frozenAt)', () => {
  it('stops every clock at the Einsatzende instead of counting on', () => {
    vi.useFakeTimers()
    try {
      const entry = Date.now() - 10 * 60_000
      const trupp = { ...aktivTrupp(), entryTime: new Date(entry).toISOString() }
      // the Einsatz ended four minutes after this Trupp went in
      mount({ trupps: [trupp], frozenAt: entry + 4 * 60_000 })
      const clock = () => screen.getByText(az.elapsed).parentElement!.textContent
      const atClose = clock()
      expect(atClose).toContain('4:00')

      // …and a minute of real time later it still reads exactly what it read at the Einsatzende
      vi.advanceTimersByTime(60_000)
      expect(clock()).toBe(atClose)
    } finally {
      vi.useRealTimers()
    }
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

  // ⚠️ The second header line exists ONLY here. In the full app it used to carry a sentence about
  // what the board is for («Lückenlose Überwachung jedes Atemschutztrupps») — a claim the operator
  // standing at the board has already made — and it was dropped on 04.09.
  it('names the Einsatz on the line the full app does not have at all', () => {
    mount({ lite })
    expect(screen.getByText(lite.subtitle)).toBeTruthy()

    cleanup()
    mount()
    expect(document.querySelector('header p')).toBeNull()
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

  it('opens the Trupp form as three sections, one open and the others readable', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ lite: { subtitle: 'Brand' }, trupps: [aktivTrupp()], createTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    // the open one is the Mannschaft; «Luft & Funk» is closed but READS ITS ANSWER OUT, so the
    // Eingangsdruck is knowable without opening anything
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(az.stackLuft) }).textContent)
      .toContain(fillTemplate(az.stackPressure, { n: dz.defaultPressureBar }))
    // …and opening it puts the field itself there
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    // …only the final submit is gated on a valid Trupp — `aria-disabled`, not the native
    // attribute, so a blocked tap still reaches attemptSubmit (which must not submit) and can
    // explain itself instead of the browser silently swallowing the click (field feedback, 02.09.)
    const submitBtn = screen.getByRole('button', { name: az.start })
    expect(submitBtn.getAttribute('aria-disabled')).toBe('true')
    // the roster is still empty, so the blocked tap OPENS the section that holds the reason —
    // never a «Speichern» sitting there with nothing to say why (field feedback, 02.09.)
    fireEvent.click(submitBtn)
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: true })).toBeTruthy()
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  // ⚠️ NO second card for this board (03.09.). It had one — `cardBig`, with its own condensed
  // header and its own flattened clock — and a phone-only arrangement of a safety card is a
  // second thing to keep in step with the first. The card the phone gets here is the card the
  // tablet grid and the row list get; what makes it fit is that the card itself got denser.
  it('uses the same card as every other board — same seven zones, in the same order', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ lite: { subtitle: 'Brand · Hauptstrasse 12' }, trupps: [aktivTrupp()] })
    const card = document.querySelector(`.${s.card}`)!
    // ⚠️ the whole zone list, in order, and NOTHING besides — one card means one zone list, and
    // that is what a phone-only arrangement would break first.
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

  /* ⚠️ A work squad's log is real and stays — angemeldet / eingerückt / draussen is its
   * chronology — but every row of it carries a bar of 0: `createTrupp` opens the log with an
   * Eingangsdruck a Trupp without Atemschutz was never asked for. The card printed «Eingerückt
   * 0 bar» under a card that says nothing else about pressure, which reads as a measurement
   * rather than as the absence of one (field report, 04.09.). */
  it('shows a work squad its Verlauf without inventing a Druck for it', () => {
    const readings: TruppReading[] = [
      { t: iso(20 * 60_000), bar: 0, kind: 'registered' },
      { t: iso(18 * 60_000), bar: 0, kind: 'entry' },
    ]
    mount({ trupps: [{ ...plainTrupp(), readings }], truppColors: { tr9: '#e2920a' } })
    const card = () => document.querySelector(`.${s.card}`)!
    expect(card().textContent).not.toContain('bar')
    // …and the rows are still there to read: open the log and the chronology is intact
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.verlauf) }))
    expect(screen.getByText(az.readingKind.entry)).toBeTruthy()
    expect(card().textContent).not.toContain('bar')
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

  /* ⚠️ Changeable while EDITING since 04.09. A Verkehrstrupp that ends up going in under PA, and a
   * Trupp registered under Atemschutz by mistake, were both a delete and a re-registration until
   * then — which throws away the record of a crew that was already working. */
  it('offers «Art des Trupps» when editing, and asks for a cylinder the moment it is needed', async () => {
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' } })
    fireEvent.click(screen.getByRole('button', { name: az.cardMenu }))
    fireEvent.click(await screen.findByRole('menuitem', { name: az.edit }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    // …and no Druck while it is still a work squad: there is no cylinder to ask about
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    expect(screen.queryByText(az.editPressureLabel)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindAtemschutz) }))
    // an upgrade records a FIRST Eingangsdruck — never «korrigieren», which would claim the Trupp
    // already had one
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    expect(screen.queryByText(az.editPressureLabel)).toBeNull()
  })

  // …but not on «Wieder einrücken»: that button is about sending the same Trupp in again, and the
  // two decisions must not ride on one press.
  it('does not offer the Art on a re-deploy', async () => {
    mount({ trupps: [{ ...plainTrupp(), status: 'raus', exitTime: iso(60_000) }], truppColors: { tr9: '#e2920a' } })
    fireEvent.click(screen.getByRole('button', { name: az.actReenter }))
    expect(screen.queryByText(az.kindLabel)).toBeNull()
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

/* ── The three-section stack on ANY phone (04.09.) ────────────────────────────────────────────
 * Replaces the two-step wizard of 02.–04.09. Three sections, all on screen, one open, the closed
 * ones reading their own answers out. What differs outside the link: the «Art des Trupps» tiles
 * lead «Luft & Funk», and the Ltg-Nr. sits in «Auftrag & Leitung» — which is ONE section, because
 * the Farbe it used to share a block with is not asked any more, on any layout. */
describe('the Trupp form on the main board’s phone layout', () => {
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })

  it('puts the Ltg-Nr. in «Auftrag & Leitung» and asks for no colour at all', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByText(az.lineNoLabel)).toBeNull() // its section is closed
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }))
    expect(screen.getByText(az.auftragLabel)).toBeTruthy()
    expect(screen.getByText(az.zielLabel)).toBeTruthy()
    expect(screen.getByText(az.lineNoLabel)).toBeTruthy()
    // ⚠️ The colour is not a question any more (04.09.) — not here and not on the tablet. It is
    // still per-Trupp and still automatic; it is simply never asked while registering one. The
    // choice lives on where the picture is read (ContextPanel, TwinTeamPill), not here.
    expect(screen.queryByText(az.colorLabel)).toBeNull()
  })

  /* A closed section is not a table of contents — it carries the ANSWER, which is what makes
     three collapsed lines a usable form rather than three doors. */
  it('reads every closed section’s answer out beside its title', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    // ⚠️ An OPEN section says nothing beside its title — the fields are right below it, and the
    // answer twice over is noise. So the Mannschaft has to be closed to be read.
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam) }).textContent)
      .not.toContain(az.stackTeamEmpty)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackTeam) }))
    // nobody picked yet — the one thing no default can answer, so it is said in as many words
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam) }).textContent)
      .toContain(az.stackTeamEmpty)
    const luft = screen.getByRole('button', { name: new RegExp(az.stackLuft) }).textContent ?? ''
    expect(luft).toContain(az.kindAtemschutz)
    expect(luft).toContain(fillTemplate(az.stackPressure, { n: dz.defaultPressureBar }))
    // …and an Auftrag nobody has set says so, in the same words the card uses
    expect(screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }).textContent)
      .toContain(az.auftragOpen)
  })

  /* ⚠️ «Art des Trupps» belongs ABOVE THE FIELDS IT GOVERNS — the Druck it adds or drops, the
   * Auftrag list it narrows — so on the phone it leads «Luft & Funk», and section 1 is the
   * Mannschaft alone (03.09.). The one thing the Art does not govern is who is in the Trupp. */
  it('leads «Luft & Funk» with the Art des Trupps chooser and leaves the Mannschaft alone', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
    expect(screen.queryByText(az.kindLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.queryByText(az.sectionTeam)).toBeNull()
  })

  it('a tablet keeps the single screen — the stack is for 375px, not for touch', () => {
    mount({ trupps: [aktivTrupp()] }) // useIsPhone false
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByRole('button', { name: new RegExp(az.stackLuft) })).toBeNull()
    expect(screen.getByText(az.pressureLabel)).toBeTruthy() // everything is already there
    // …and there the chooser is still FIRST and spans the form, above the two columns it governs
    const body = document.querySelector(`.${s.modalBody}`)
    expect(body?.firstElementChild?.className).toContain(s.formColWide)
    expect(body?.firstElementChild?.textContent).toContain(az.kindLabel)
  })

  /* ⚠️ Reversed on 03.09., and it still holds: the Art must never restructure the FORM, only
   * what «Luft & Funk» contains. The tap adds and drops the Druck row inside the open section —
   * ordinary form behaviour — and never moves which section is open or what the others hold. */
  it('keeps the same three sections for a Trupp without Atemschutz, minus the Druck', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    // the section itself is unchanged by the tap: still open, still the chooser, still the Kanal
    expect(screen.getByRole('button', { name: new RegExp(az.stackLuft), expanded: true })).toBeTruthy()
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.getByText(az.funkkanalSection)).toBeTruthy()
    // …minus the one field a Verkehrstrupp has no cylinder for
    expect(screen.queryByText(az.pressureLabel)).toBeNull()
    // and the other sections are untouched — the Mannschaft is where it was left
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackTeam) }))
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  /* The «point at what blocks the save» path keys off the stack alone, so a plain Trupp gets the
   * same «Speichern» that opens the section holding the missing Gruppenführer instead of sitting
   * there doing nothing (02.09.). */
  it('opens the Mannschaft when a plain Trupp is saved without a Gruppenführer', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ trupps: [aktivTrupp()], createTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: true })).toBeTruthy()
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  /* ⚠️ A section can be CLOSED again, including the one that opened first (field feedback,
   * 04.09.). Three collapsed lines that each read their own answer is the overview the stack
   * exists for — locking one open would make it a wizard with extra steps. */
  it('lets every section be closed again, leaving three lines that still say everything', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackTeam) }))
    expect(screen.queryByText(az.sectionTeam)).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: false })).toBeTruthy()
    // …and the one control that finishes the job is still right there, never behind a step
    expect(screen.getByRole('button', { name: az.start })).toBeTruthy()
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
