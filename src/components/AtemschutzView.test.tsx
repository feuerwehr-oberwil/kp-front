// @vitest-environment jsdom
// The 29.08. card rework, as it stands after the same-day revision: the contact clock folds
// its timing rows and the Verlauf footer previews the latest event and expands the log — both
// OPEN-ONLY (showing never logs, never counts as Kontakt). The Druck stepper is back inline
// (a Druckmeldung must never cost an opening tap); its ± only stages a pending value and the
// explicit «Bestätigen» commits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    expect(screen.getByText(new RegExp(az.wizardAir))).toBeTruthy()
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
