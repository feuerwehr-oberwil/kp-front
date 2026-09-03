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

describe('the Kontakt zone (tap the clock, fold the times)', () => {
  it('shows and hides the timing rows — and never records a Kontakt', () => {
    const props = mount()
    expect(screen.queryByText(az.lastContactAt)).toBeNull() // collapsed by default
    const clock = screen.getByRole('button', { name: new RegExp(az.clockOk) })
    fireEvent.click(clock)
    expect(screen.getByText(az.lastContactAt)).toBeTruthy()
    expect(screen.getByText(az.nextContactDue)).toBeTruthy()
    expect(props.recordContact).not.toHaveBeenCalled()
    fireEvent.click(clock)
    expect(screen.queryByText(az.lastContactAt)).toBeNull()
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

  it('drops Platzieren, Leitung and the order menu — and keeps Kontakt and Bearbeiten', () => {
    mount({ lite, onOrder: noop, trupps: [aktivTrupp(), { ...aktivTrupp(), id: 'tr2', name: 'Meier' }] })
    expect(screen.queryByRole('button', { name: az.place })).toBeNull()
    expect(screen.queryByRole('button', { name: az.linePick })).toBeNull()
    expect(screen.queryByRole('button', { name: az.orderLabel })).toBeNull()
    // …and no «Abmelden» (02.09.): the link owns no login on this phone, and the button that
    // stood beside the bell ended the phone's own one (lib/linkMode).
    expect(screen.queryByRole('button', { name: appConfig.copy.incidentSwitcher.logout })).toBeNull()
    expect(screen.getAllByRole('button', { name: az.edit }).length).toBe(2)
    expect(screen.getAllByRole('button', { name: az.actContact }).length).toBe(2)
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

  // Density redesign (mock 02, 03.09.): the tablet's separate banner + name rows condense into
  // one identity row and one crew/chips row, and the hero clock flattens into a band — all so
  // 3–4 Trupps plus the focused card fit a phone screen without scrolling. Kontakt itself stays
  // on the card (a maintainer correction reverted an earlier sticky-footer attempt).
  it('condenses the focused card into a toprow + metaline, and flattens the clock into a band', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ lite: { subtitle: 'Brand · Hauptstrasse 12' }, trupps: [aktivTrupp()] })
    const card = document.querySelector(`.${s.card}`)
    expect(card?.querySelector(`.${s.toprow}`)).toBeTruthy()
    expect(card?.querySelector(`.${s.metaline}`)).toBeTruthy()
    expect(card?.querySelector(`.${s.clockBand}`)).toBeTruthy()
    // superseded by `.toprow` — the old two-row banner/name split no longer renders here
    expect(card?.querySelector(`.${s.cardBanner}`)).toBeNull()
    expect(card?.querySelector(`.${s.cardName}`)).toBeNull()
    // Kontakt is still an in-card control, not a pinned screen-edge bar
    expect(card?.querySelector(`.${s.kontaktBtn}`)).toBeTruthy()
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

/* ── Trupps ohne Atemschutz — «Sektionen» (mock 02, decided 03.09.) ───────────────────────────
 * One board, two sections. The point of this variant is that the PA safety signal is not
 * diluted, so the tests pin the SEPARATION (a plain Trupp gets a row and none of the monitoring
 * controls) rather than the section's own styling. */
describe('the board with Trupps that are not under Atemschutz', () => {
  const plainTrupp = (): Trupp => ({
    id: 'tr9', kind: 'einfach', name: 'Gerber', members: ['Stalder'],
    auftrag: 'sichern', ziel: 'Zufahrt Hauptstrasse', funkkanal: 1,
    entryPressureBar: 0, entryTime: iso(20 * 60_000), lastContactTime: '', status: 'aktiv',
  })

  it('leaves an all-Atemschutz board exactly as it was — no headings, no second half', () => {
    mount()
    expect(screen.queryByText(az.sectionAtemschutz)).toBeNull()
    expect(screen.queryByText(az.sectionPlain)).toBeNull()
    expect(document.querySelector(`.${s.plainList}`)).toBeNull()
  })

  it('splits into «Atemschutz» + «Weitere Trupps» and gives the plain Trupp a row, not a card', () => {
    mount({ trupps: [aktivTrupp(), plainTrupp()], truppColors: { tr1: '#e8392b', tr9: '#e2920a' } })
    expect(screen.getByText(az.sectionAtemschutz)).toBeTruthy()
    expect(screen.getByText(az.sectionPlain)).toBeTruthy()
    expect(screen.getByText(az.sectionPlainHint)).toBeTruthy()
    // the PA half keeps its card; the work squad is one row in the second half
    expect(document.querySelectorAll(`.${s.card}`)).toHaveLength(1)
    const rows = document.querySelectorAll(`.${s.prow}`)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Gerber')
    // …and the row carries NONE of the monitoring vocabulary: no clock, no Druck, no Kontakt
    expect(rows[0].querySelector(`.${s.kontaktBtn}`)).toBeNull()
    expect(rows[0].textContent).not.toContain('bar')
    expect(screen.getAllByRole('button', { name: az.actContact })).toHaveLength(1) // the PA card's
  })

  it('says so when the Atemschutz half is empty rather than leaving a bare heading', () => {
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' } })
    expect(screen.getByText(az.sectionAtemschutzEmpty)).toBeTruthy()
    expect(document.querySelectorAll(`.${s.card}`)).toHaveLength(0)
  })

  it('offers the row the one lifecycle step its state actually has', () => {
    const setTruppStatus = vi.fn()
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' }, setTruppStatus })
    expect(screen.queryByRole('button', { name: az.actEnter })).toBeNull() // it is already in
    fireEvent.click(screen.getByRole('button', { name: az.actExit }))
    expect(setTruppStatus).toHaveBeenCalledWith('tr9', 'raus')
  })

  /* ⚠️ The row is LIGHTER than a card, not smaller in function: it has no card behind it to open,
   * so every control it drops is a control that is gone. The 03.09. phone pass tightened the row
   * to three bands and this is the seam it must not cross — bearbeiten, setzen and entfernen stay
   * ON the row, next to the lifecycle step (pinned above). */
  it('keeps bearbeiten · setzen · entfernen on the row itself, not behind an opening tap', () => {
    const deleteTrupp = vi.fn()
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' }, deleteTrupp })
    const row = document.querySelector(`.${s.prow}`)!
    for (const label of [az.edit, az.place, az.remove]) {
      expect(row.contains(screen.getByRole('button', { name: label }))).toBe(true)
    }
    fireEvent.click(screen.getByRole('button', { name: az.remove }))
    expect(deleteTrupp).toHaveBeenCalledWith('tr9')
  })

  // The handed-over Tafel operates the Atemschutzüberwachung and nothing else — that is what the
  // QR promises and what the link's backend allowlist permits.
  it('hides plain Trupps entirely on the handed-over board, and offers no way to create one', () => {
    mount({ lite: { subtitle: 'Brand' }, trupps: [aktivTrupp(), plainTrupp()], truppColors: { tr1: '#e8392b', tr9: '#e2920a' } })
    expect(screen.queryByText('Gerber')).toBeNull()
    expect(document.querySelector(`.${s.plainList}`)).toBeNull()
    expect(screen.queryByText(az.sectionPlain)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByText(az.kindLabel)).toBeNull()
  })

  it('asks «Art des Trupps» once, on creation only — the kind is fixed afterwards', () => {
    mount({ trupps: [plainTrupp()], truppColors: { tr9: '#e2920a' } })
    fireEvent.click(screen.getAllByRole('button', { name: az.edit })[0])
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
 * fold and now shares it. The two differences that matter: outside the link step 2 also carries
 * Leitung und Farbe, and a Trupp without Atemschutz has no second step at all. */
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

  it('a tablet keeps the single screen — the wizard is for 375px, not for touch', () => {
    mount({ trupps: [aktivTrupp()] }) // useIsPhone false
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.queryByRole('button', { name: az.wizardNext })).toBeNull()
    expect(screen.getByText(az.pressureLabel)).toBeTruthy() // everything is already there
  })

  it('drops the wizard for a Trupp without Atemschutz — there is nothing to split off', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mount({ trupps: [aktivTrupp()] })
    fireEvent.click(screen.getByRole('button', { name: az.newTrupp }))
    expect(screen.getByRole('button', { name: az.wizardNext })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(az.kindPlain) }))
    expect(screen.queryByRole('button', { name: az.wizardNext })).toBeNull()
    // one screen: the roster AND the Auftrag are both on it
    expect(screen.getByText(az.sectionTeam)).toBeTruthy()
    expect(screen.getByText(az.zielLabel)).toBeTruthy()
  })
})
