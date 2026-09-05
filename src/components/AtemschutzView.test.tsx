// @vitest-environment jsdom
// The 29.08. card rework, as it stands after the same-day revision: the contact clock folds
// its timing rows and the Verlauf footer previews the latest event and expands the log — both
// OPEN-ONLY (showing never logs, never counts as Kontakt). The Druck stepper is back inline
// (a Druckmeldung must never cost an opening tap); its ± only stages a pending value and the
// explicit «Bestätigen» commits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import { useIsPhone } from '../lib/useIsPhone'
import s from './Atemschutz.module.css'
import { appConfig } from '../config/appConfig'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { fillTemplate } from '../lib/format'
import { clearAllDrafts } from '../lib/draftKeep'
import type { AttendanceState, Trupp, TruppFields, TruppReading } from '../types'

afterEach(cleanup)
// ⚠️ …and the kept DRAFTS with it (lib/draftKeep is a module-level store): a form that was
// deliberately left blocked here — «Trupp anmelden» without an Auftrag — would otherwise hand its
// half-typed crew to the next test in this file.
afterEach(clearAllDrafts)
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

/** Name a Gruppenführer by hand in the open Trupp form. Since 04.09. the SEARCH field is the
 *  guest entry (TruppTeam): type the name, then take the Gast row the list grows for it. */
const typeGuest = (name: string) => {
  fireEvent.change(screen.getByLabelText(az.teamSearchPlaceholder), { target: { value: name } })
  fireEvent.click(screen.getByRole('option', { name: fillTemplate(az.teamGuestAdd, { name }) }))
}
/** Answering the Auftrag — required to REGISTER a Trupp since 04.09. (see «the Auftrag is what a
 *  Trupp is registered FOR» below), so every test that means to CREATE one has to say it. */
const pickAuftrag = (label = 'Retten') =>
  fireEvent.click(within(screen.getByRole('group', { name: az.auftragLabel })).getByRole('button', { name: label }))

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

  /* ⚠️ …and no time either (05.09., reversing the 04.09. break clock): once a crew is out we
   * don't care how long it has been resting — the word alone is the whole statement. */
  it('gives a Trupp that is out its word alone — no tier, no clock, no time', () => {
    mount({ trupps: [{ ...aktivTrupp(), status: 'raus', exitTime: iso(5 * 60_000) }] })
    expect(screen.getByText(az.status.raus)).toBeTruthy()
    expect(screen.queryByText(az.outFor)).toBeNull()
    expect(screen.queryByText(az.clockOk)).toBeNull()
    expect(screen.queryByText(az.sinceContact)).toBeNull()
    const band = document.querySelector(`.${s.bandVal}`)!
    expect(band.textContent).toBe('')
  })

  /* ⚠️ «Nicht eingesetzt» gets NO running clock (04.09.). A Sicherungstrupp that was stood down
   * without ever going under PA wore the break clock under «Draussen seit» — the card's loudest
   * element, ticking — which claims the crew came out of something AND presses for a recovery
   * nobody has to take. What it has is the moment it was announced: a time, not a duration. */
  it('gives a Trupp that never went in its Anmeldezeit, and no clock at all', () => {
    mount({ trupps: [{
      ...aktivTrupp(), status: 'raus', entryTime: '', exitTime: iso(5 * 60_000),
      readings: [{ t: iso(40 * 60_000), bar: 300, kind: 'registered' }],
    }] })
    expect(screen.getByText(az.statusNotDeployed)).toBeTruthy()
    expect(screen.getByText(az.bandRegisteredAt)).toBeTruthy()
    // the break clock's own caption is exactly what must NOT stand over this card
    expect(screen.queryByText(az.outFor)).toBeNull()
    // …and the value beside it is a wall-clock time, never a running mm:ss
    const band = document.querySelector(`.${s.bandVal}`)!
    expect(band.textContent).toMatch(/^\d{2}:\d{2}$/)
  })

  /* …and BOTH out states hand the loud type back. The 40px bold number belongs to the crews that
   * are inside — that is the reading order of the whole board — and a break clock in the same
   * weight put a Trupp nobody is watching at the top of the eye's list. */
  it('draws both out states quietly, and leaves the loud band to the crews inside', () => {
    for (const t of [
      { ...aktivTrupp(), status: 'raus' as const, exitTime: iso(5 * 60_000) },
      { ...aktivTrupp(), status: 'raus' as const, entryTime: '', exitTime: iso(5 * 60_000),
        readings: [{ t: iso(40 * 60_000), bar: 300, kind: 'registered' as const }] },
    ]) {
      cleanup()
      mount({ trupps: [t] })
      expect(document.querySelector(`.${s.band}`)!.className).toContain(s.bandQuiet)
    }
    cleanup()
    mount() // still inside: this is the one card that keeps the big number
    expect(document.querySelector(`.${s.band}`)!.className).not.toContain(s.bandQuiet)
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
/* ⚠️ «Raus melden» used to lead this row (the quiet button first). Reversed 04.09. on Manuel's
 * feedback: the row is read while both steps are still ahead, so it runs in the order the Einsatz
 * runs — the crew is called back, then it comes out. */
describe('the lifecycle row: in the order the Einsatz runs', () => {
  it('puts the Rückzug decision before «Raus melden», on both in-field states', () => {
    for (const status of ['aktiv', 'rueckzug'] as const) {
      cleanup()
      mount({ trupps: [{ ...aktivTrupp(), status }] })
      const labels = [...document.querySelectorAll(`.${s.actions} .${s.actBtn}`)].map((b) => b.textContent)
      expect(labels).toEqual([status === 'aktiv' ? az.actRueckzug : az.actContinue, az.actExit])
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

/* ⚠️ Field report, 04.09.: opening a Trupp on the phone moved the toggle's chevron from the right
 * edge of the row to the LEFT edge of the card head, «to make room for the ⋯» — and the pixel the
 * thumb had just pressed became the ⋯, whose menu carries «Entfernen». One control drawn twice has
 * to stay in one place; the far-right slot was originally kept clear to shield a bin that has been
 * inside the ⋯ since 03.09. */
describe('the row ⇄ card toggle keeps its place', () => {
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })

  it('leaves the collapse chevron at the trailing edge, with the ⋯ inside it', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    // the closed row: the chevron is the row's last child
    const row = document.querySelector(`.${s.trow}`)!
    expect(row.lastElementChild!.className).toContain(s.trowChevron)

    fireEvent.click(row)
    const head = document.querySelector(`.${s.cardHead}`)!
    const chevron = screen.getByRole('button', { name: az.collapse })
    const menu = screen.getByRole('button', { name: az.cardMenu })
    expect(head.lastElementChild).toBe(chevron)
    // …and the ⋯ sits before it, never in the slot the chevron was tapped in
    expect(chevron.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
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
    expect(rail?.querySelectorAll(`.${s.tab}`).length).toBe(3) // 2 Trupps + «+ Trupp»
    // the bell stays in the header's own action group — NOT in the rail
    expect(document.querySelector(`.${s.headActs} .${s.muteBtn}`)).toBeTruthy()
    expect(rail?.querySelector(`.${s.muteBtn}`)).toBeNull()
    // ⚠️ «+ Trupp» is the LAST CELL OF THE STRIP'S OWN GRID (05.09.), not a 44px square in a
    // column beside it: same width and same row height as a Trupp chip, so it can neither
    // out-size them nor take the width their names need.
    const addBtn = screen.getByRole('button', { name: az.newTrupp })
    expect(document.querySelector(`.${s.strip}`)?.lastElementChild).toBe(addBtn)
    expect(addBtn.classList.contains(s.tab)).toBe(true)
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
    // ⚠️ …and the Eintritt SAYS what went in (04.09., Manuel): «Atemschutz beendet» followed by a
    // bare «Eingerückt» left the reader unable to tell whether the crew was wearing masks.
    expect(screen.getByText(fillTemplate(az.readingNoAs, { what: az.readingKind.entry }))).toBeTruthy()
    expect(screen.queryByText(az.readingKind.entry)).toBeNull()
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

  /* ⚠️ …and on «Wieder einrücken» too (04.09., Feldtest: «Bei Wieder einrücken (AS) habe ich
   * keine Auswahl ob mit oder ohne AS»), reversing «the two decisions must not ride on one press»
   * from the same day. Each re-deployment is its own Einsatz of that crew: the Trupp that fought
   * the fire under PA goes back in to clear up without it. */
  it('asks the Art again on a re-deploy, and sends a Trupp back in WITHOUT Atemschutz', () => {
    const reactivateTrupp = vi.fn()
    mount({
      reactivateTrupp,
      trupps: [{ ...aktivTrupp(), status: 'raus', exitTime: iso(60_000) }],
    })
    fireEvent.click(screen.getByRole('button', { name: az.actReenter }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    // a fresh cylinder is what the form opens on…
    expect(screen.getByText(az.newPressureLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    // …and there is none to ask for once the crew goes back in without a mask
    expect(screen.queryByText(az.newPressureLabel)).toBeNull()
    // «Bereitstellen» goes with it: a Sicherungstrupp is by definition a crew standing by under PA
    expect(screen.queryByRole('button', { name: az.reenterStandby })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.reenterSubmit }))
    expect(reactivateTrupp).toHaveBeenCalledTimes(1)
    const [, fields] = reactivateTrupp.mock.calls[0] as [string, TruppFields]
    expect(fields.kind).toBe('einfach')
    expect(fields.pressure).toBe(0)
  })

  // the other direction: the Verkehrstrupp that has finished puts masks on for the cellar — and
  // then the Eingangsdruck is asked for and gates the save, exactly as it does on a new Trupp
  it('asks for an Eingangsdruck when a plain Trupp goes back in under Atemschutz', () => {
    const reactivateTrupp = vi.fn()
    mount({
      reactivateTrupp,
      trupps: [{ ...plainTrupp(), status: 'raus', exitTime: iso(60_000) }],
      truppColors: { tr9: '#e2920a' },
    })
    fireEvent.click(screen.getByRole('button', { name: az.actReenter }))
    expect(screen.queryByText(az.newPressureLabel)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindAtemschutz) }))
    // the station's default cylinder, not the 0 bar the plain card carries — a stepper opening on
    // a value the submit then refuses is the dead button this form does not have
    expect(screen.getByText(az.newPressureLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: az.reenterSubmit }))
    const [, fields] = reactivateTrupp.mock.calls[0] as [string, TruppFields]
    expect(fields.kind).toBe('atemschutz')
    expect(fields.pressure).toBe(atemschutzDoctrine().defaultPressureBar)
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
    pickAuftrag('Verkehr')
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
    pickAuftrag()
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect('kind' in (createTrupp.mock.calls[0][0] as object)).toBe(false)
  })
})

/* ── The Auftrag is what a Trupp is registered FOR (04.09., Feldtest) ──────────────────────────
 * Reverses the 30.08. «the Auftrag no longer blocks» for the CREATE path only: left open at der
 * Anmeldung it stayed open, so the board filled with «Auftrag offen» cards and the Rapport
 * printed crews whose job nobody could reconstruct. Blocking is not a disabled button — the tap
 * opens the section the answer lives in and rings the field, the way every other blocked save on
 * this form already behaves. */
describe('the Auftrag a Trupp is registered for', () => {
  // the phone case below flips the shared useIsPhone mock — put it back, or every later test in
  // this file gets the compact board
  afterEach(() => { vi.mocked(useIsPhone).mockReturnValue(false) })

  it('refuses to register a Trupp with no Auftrag, and registers it once one is given', () => {
    const createTrupp = vi.fn()
    mount({ createTrupp, trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    typeGuest('Meier Thomas')
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    // the form stays open with everything typed still in it
    expect(screen.getByRole('button', { name: az.start })).toBeTruthy()
    pickAuftrag()
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).toHaveBeenCalledTimes(1)
    expect((createTrupp.mock.calls[0][0] as Trupp).auftrag).toBe('retten')
  })

  // the free text alone answers it too — that is what «Anderes» is for, and a Ziel without a tile
  // («2OG links») is a complete order
  it('takes the Ziel text on its own as the answer', () => {
    const createTrupp = vi.fn()
    mount({ createTrupp, trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    typeGuest('Meier Thomas')
    fireEvent.change(screen.getByLabelText(az.zielLabel), { target: { value: '2OG links' } })
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).toHaveBeenCalledTimes(1)
  })

  it('opens the collapsed «Auftrag & Leitung» section on the phone and puts the focus on the tiles', async () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ createTrupp, trupps: [] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    typeGuest('Meier Thomas')
    // creating opens the Mannschaft, so the Auftrag is behind a fold — nobody has to find the
    // chevron for it
    expect(screen.getByRole('button', { name: new RegExp(az.stackAuftrag), expanded: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new RegExp(az.stackAuftrag), expanded: true })).toBeTruthy()
    // the ring + focus land on the next frame — the fields do not exist until the section opens
    await waitFor(() => {
      const tiles = within(screen.getByRole('group', { name: az.auftragLabel })).getAllByRole('button')
      expect(document.activeElement).toBe(tiles[0])
    })
  })

  // ⚠️ EDITING is never blocked: the clock is running, the operator came here to correct
  // something else, and a form that refuses to close would lose that correction.
  it('lets a Trupp that is already in the field be saved with the Auftrag still open', async () => {
    const editTrupp = vi.fn()
    mount({ editTrupp, trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.cardMenu }))
    fireEvent.click(await screen.findByRole('menuitem', { name: az.edit }))
    fireEvent.click(screen.getByRole('button', { name: az.save }))
    expect(editTrupp).toHaveBeenCalledTimes(1)
    expect((editTrupp.mock.calls[0][1] as { auftrag?: string }).auftrag).toBeUndefined()
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

  /* ⚠️ The Mannschaft is a CHIP ROW on the phone (05.09.). Three reserved slot rows plus a
   * standing roster filled the form before anybody had been picked, and the crew that was
   * actually chosen was the smallest thing on it. Here the empty Trupp is one dashed chip and the
   * roster appears only under a typed query — the Gast door included, so the one way in is
   * unchanged. The behaviour itself is pinned in TruppTeam.test.tsx; this checks the form the
   * operator opens really gets the phone skin. */
  it('makes the Mannschaft a chip row — no standing roster, and the Gast door still opens', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()], personnel: [
      { id: 'p1', displayName: 'Muster Anna', active: true, updatedAt: '2026-09-05T06:00:00.000Z' },
    ] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByRole('listbox', { name: az.sectionTeam })).toBeNull()
    expect(screen.getByText(az.teamChipsEmpty)).toBeTruthy()
    typeGuest('Frei Nadja')
    expect(screen.getByText('Frei Nadja')).toBeTruthy()
    // …and with the query cleared the roster is gone again rather than left standing
    expect(screen.queryByRole('listbox', { name: az.sectionTeam })).toBeNull()
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
    expect(luft).toContain(fillTemplate(az.stackPressure, { n: dz.defaultPressureBar }))
    // …and an Auftrag nobody has set says so, in the same words the card uses — led by the Art,
    // whose tiles moved into this section on 05.09.
    const auftrag = screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }).textContent ?? ''
    expect(auftrag).toContain(az.kindAtemschutz)
    expect(auftrag).toContain(az.auftragOpen)
  })

  /* ⚠️ The stack's order is Mannschaft → Auftrag & Leitung → Luft & Funk, and «Art des Trupps»
   * rides with the AUFTRAG (05.09., field feedback). What the Art decides first is what the crew
   * is sent to do — it narrows the Auftrag vocabulary, and «Ohne Atemschutz» removes the Druck
   * from the section BELOW it, so asking it there meant walking back up to change it. Section 1
   * stays the Mannschaft alone: who is in the Trupp is the one thing the Art does not govern. */
  it('puts «Auftrag & Leitung» second, with the Art des Trupps chooser, and «Luft & Funk» last', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    const heads = [...document.querySelectorAll(`.${s.secHead}`)].map((e) => e.textContent ?? '')
    expect(heads[0]).toContain(az.stackTeam)
    expect(heads[1]).toContain(az.stackAuftrag)
    expect(heads[2]).toContain(az.stackLuft)
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
    expect(screen.queryByText(az.kindLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }))
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.getByText(az.auftragLabel)).toBeTruthy()
    expect(screen.queryByText(az.sectionTeam)).toBeNull()
    // …and it is NOT in «Luft & Funk» any more
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    expect(screen.getByText(az.pressureLabel)).toBeTruthy()
    expect(screen.queryByText(az.kindLabel)).toBeNull()
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

  /* ── The Reihenfolge menu (04.09., Feldtest Manuel) ───────────────────────────────────────────
 * Two comparators, two findings: «den länger andauernden Einsatz zuerst» (the AS half already did
 * that through its contact clock — this is the answer for everything that has no clock), and
 * crews that are draussen or standing by sitting left of the ones actually working. */
describe('the Reihenfolge menu', () => {
  const plain = (id: string, name: string, over: Partial<Trupp> = {}): Trupp => ({
    id, kind: 'einfach', name, entryPressureBar: 0, entryTime: iso(10 * 60_000),
    lastContactTime: '', status: 'aktiv', ...over,
  })
  const names = () => [...document.querySelectorAll(`.${s.nameStatic}`)].map((e) => e.textContent)

  it('Dringlichkeit: among equals, the deployment that has run longest comes first', () => {
    mount({ order: 'dringlichkeit', trupps: [
      plain('t1', 'Kurz', { entryTime: iso(5 * 60_000) }),
      plain('t2', 'Lang', { entryTime: iso(45 * 60_000) }),
    ] })
    expect(names()).toEqual(['Lang', 'Kurz'])
  })

  // ⚠️ a FINISHED deployment keeps its total for the card to print, and it must not buy the card
  // a place at the top of an urgency sort
  it('…and a Trupp that has come out does not outrank one still out there', () => {
    mount({ order: 'dringlichkeit', trupps: [
      plain('t1', 'Fertig', { entryTime: iso(120 * 60_000), status: 'raus', exitTime: iso(60 * 60_000) }),
      plain('t2', 'Drin', { entryTime: iso(5 * 60_000) }),
    ] })
    expect(names()).toEqual(['Drin', 'Fertig'])
  })

  it('Auftrag: the crews out there first, then who is waiting, then who has finished', () => {
    mount({ order: 'auftrag', trupps: [
      // «Bereitstellung» leads the alphabet — under the old comparator it led the board
      plain('t1', 'Fertig', { auftrag: 'bereitstellung', status: 'raus', exitTime: iso(5 * 60_000) }),
      plain('t2', 'Wartet', { auftrag: 'sanitaet', status: 'angemeldet', entryTime: '' }),
      plain('t3', 'Drin', { auftrag: 'verkehr' }),
    ] })
    expect(names()).toEqual(['Drin', 'Wartet', 'Fertig'])
  })

  it('…and within one of those groups the Auftrag still orders the alphabet, with none last', () => {
    mount({ order: 'auftrag', trupps: [
      plain('t1', 'Ohne'),
      plain('t2', 'Verkehr', { auftrag: 'verkehr' }),
      plain('t3', 'Sanität', { auftrag: 'sanitaet' }),
    ] })
    expect(names()).toEqual(['Sanität', 'Verkehr', 'Ohne'])
  })
})

/* ⚠️ Reversed on 03.09., and it still holds: the Art must never restructure the FORM, only which
   * fields «Luft & Funk» contains. The tap drops the Druck row from the section below it —
   * ordinary form behaviour — and never moves which section is open or what the others hold. */
  it('keeps the same three sections for a Trupp without Atemschutz, minus the Druck', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }))
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    // the section itself is unchanged by the tap: still open, still the chooser, still the Auftrag
    expect(screen.getByRole('button', { name: new RegExp(az.stackAuftrag), expanded: true })).toBeTruthy()
    expect(screen.getByText(az.kindLabel)).toBeTruthy()
    expect(screen.getByText(az.auftragLabel)).toBeTruthy()
    // …and «Luft & Funk» keeps the Kanal, minus the one field a Verkehrstrupp has no cylinder for
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    expect(screen.getByText(az.funkkanalSection)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackAuftrag) }))
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: true })).toBeTruthy()
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
  })

  /* ⚠️ The reason a save was refused belongs to the FORM, not to the app's toast lane (05.09.,
   * field feedback). That lane is pinned to the bottom of the VIEWPORT — on this sheet a pill
   * hanging in the form's own empty space above the footer, and a pill with `pointer-events:
   * auto` sitting over whatever field happens to be under it. On a phone that field is the
   * Auftrag «Art» chips, which is the whole of the «needs two taps to change the Art» defect. */
  it('says why the save was refused in the sheet itself, on the footer’s own edge', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const createTrupp = vi.fn()
    mount({ trupps: [aktivTrupp()], createTrupp })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    fireEvent.click(screen.getByRole('button', { name: az.start }))
    expect(createTrupp).not.toHaveBeenCalled()
    const bar = document.querySelector(`.${s.formBlocked}`)
    expect(bar?.textContent).toContain(az.saveBlockedTeam)
    // …and it is the last row before the actions it is about — not floating anywhere else
    expect(bar?.nextElementSibling?.className).toContain(s.modalFoot)
  })

  /* ⚠️ «X ist bereits in einem anderen Trupp» is fixed in the MANNSCHAFT and nowhere else
   * (05.09.): the sentence names a person, and taking them out of this Trupp is section 1's job.
   * It used to be an inert <p> that only rang itself, leaving whichever section happened to be
   * open standing. */
  it('sends the double-assignment warning to the Mannschaft — from the sentence and from the save', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const editTrupp = vi.fn()
    const shared = { ...aktivTrupp(), leaderPersonId: 'p1' }
    mount({ editTrupp, trupps: [
      shared,
      { ...aktivTrupp(), id: 'tr2', name: 'Meier', leaderPersonId: 'p1' },
    ] })
    fireEvent.click(screen.getAllByRole('button', { name: /Steiner/ })[0]) // the row → its card
    fireEvent.click(screen.getAllByRole('button', { name: az.cardMenu })[0])
    fireEvent.click(screen.getByRole('menuitem', { name: az.edit }))
    // the form opens on «Luft & Funk» for an edit — the section the warning is NOT about
    expect(screen.getByRole('button', { name: new RegExp(az.stackLuft), expanded: true })).toBeTruthy()
    const warn = document.querySelector<HTMLButtonElement>(`.${s.formWarn}`)!
    expect(warn.textContent).toContain(fillTemplate(az.assignedConflict, { name: 'Steiner' }))
    fireEvent.click(warn)
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: true })).toBeTruthy()
    // …and so does a blocked save, instead of only ringing the sentence
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.stackLuft) }))
    fireEvent.click(screen.getByRole('button', { name: az.save }))
    expect(editTrupp).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new RegExp(az.stackTeam), expanded: true })).toBeTruthy()
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

/* ⚠️ Field report, 04.09.: on a 66-person Mannschaft the Gast door — «Name eingeben (Gast /
 * Nachbarwehr)», the second field — sat BELOW the whole roster list, so the one case the list
 * cannot answer was the case whose answer sat furthest away. There is no second field any more:
 * the SEARCH is the name entry, and the door is the last row of the list, present only while
 * something is typed. The full behaviour is pinned in TruppTeam.test.tsx; this one checks that
 * the form the operator actually opens still gets a Gast into the Trupp. */
describe('the Gast door in the person picker', () => {
  const roster = Array.from({ length: 40 }, (_, i) => ({
    id: `p${i}`, displayName: `Muster ${String(i).padStart(2, '0')}`, active: true,
    updatedAt: '2026-09-04T06:00:00.000Z',
  }))

  it('takes a Gast straight out of the search, with no second field to find', () => {
    mount({ trupps: [aktivTrupp()], personnel: roster })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    const list = screen.getByRole('listbox', { name: az.sectionTeam })

    // at rest the list is the Mannschaft and nothing else — no permanent Gast row
    expect(within(list).getAllByRole('option').length).toBe(roster.length)
    typeGuest('Frei Nadja')
    expect(screen.getByText('Frei Nadja')).toBeTruthy()
    // …and the query is cleared, so the list is the whole Mannschaft again for the next member
    expect((screen.getByLabelText(az.teamSearchPlaceholder) as HTMLInputElement).value).toBe('')
  })
})

/* ⚠️ «2 Alarme» rings TWO cards (05.09., field feedback). The badge counts every Trupp past its
 * line — pointing at exactly one of them answered a different question than the one printed on
 * it, and «welche denn?» was still a scroll. The SCROLL stays on the one the badge ranks first
 * (the TopBar chip's pick): two smooth scrolls fired at once land wherever the last one
 * happened to render. */
describe('the überfällig badge in the header', () => {
  const overdue = (id: string, name: string): Trupp => ({
    ...aktivTrupp(), id, name, lastContactTime: iso(60 * 60_000),
  })
  const flashedNames = () =>
    [...document.querySelectorAll(`.${s.cardFlash}`)].map((el) => el.querySelector(`.${s.nameStatic}`)?.textContent)

  it('rings every alarmed Trupp, not only the one it jumps to', () => {
    mount({ trupps: [
      overdue('tr1', 'Steiner'), overdue('tr2', 'Meier'),
      { ...aktivTrupp(), id: 'tr3', name: 'Gerber' },
    ] })
    const badge = document.querySelector<HTMLButtonElement>(`.${s.overdueBadge}`)!
    expect(badge.textContent).toContain(az.overdueBadge(2))
    // arriving during an alarm already points at ONE card (the ranked one) — that is unchanged
    expect(flashedNames()).toEqual(['Steiner'])
    fireEvent.click(badge)
    expect(flashedNames()).toEqual(['Steiner', 'Meier'])
  })
})
