// @vitest-environment jsdom
//
// The phone's three tabs (ReportPreflight · PhoneTab). jsdom applies no stylesheet, so what is
// asserted here is the pair the CSS keys off — `data-phone-tab` on the body and `data-tab` on
// each block — not pixels. That pair IS the mechanism: get it wrong and a section either never
// appears or appears in all three tabs.
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight, requestReportTab } from './ReportPreflight'

// The Rapport asks whether it is on a phone (useIsPhone → matchMedia) to decide whether the
// Kroki map may be mounted; jsdom implements no matchMedia. Pinned to «not a phone», which is
// the surface these tests are about.
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})


afterEach(cleanup)
// the last-used tab lives in sessionStorage (lib/reportTabs) and jsdom keeps it between tests
beforeEach(() => sessionStorage.clear())

const START = new Date(2026, 7, 14, 19, 42)
const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: START.toISOString(), closed_at: null,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

function setup() {
  const r = render(
    <ReportPreflight
      incident={INCIDENT}
      reportMeta={{ alarmiertAt: START.toISOString() }}
      events={[]}
      annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
      mapContentCount={0}
      onSaveMeta={vi.fn()}
    />,
  )
  return { ...r, body: () => document.querySelector('.report-preflight-body') as HTMLElement }
}

const tabOf = (step: string) =>
  document.querySelector(`[data-step="${step}"]`)?.closest('[data-tab]')?.getAttribute('data-tab')

const isChecked = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true'

describe('Einsatzrapport · phone tabs', () => {
  it('opens on «Bericht»', () => {
    const { body } = setup()
    expect(body().dataset.phoneTab).toBe('bericht')
  })

  it('files every Mindestangabe in exactly one tab', () => {
    setup()
    // the form half…
    expect(tabOf('kurzbericht')).toBe('bericht')
    expect(tabOf('einsatzleiter')).toBe('bericht')
    expect(tabOf('kontaktperson')).toBe('bericht')
    expect(tabOf('zeiten')).toBe('bericht')
    expect(tabOf('rueckmeldung')).toBe('bericht')
    // …and the round-up that gets read out at the Appell
    expect(tabOf('anwesenheit')).toBe('werwas')
    expect(tabOf('mittel')).toBe('werwas')
  })

  it('switches when a tab is picked', () => {
    const { body } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Personal & Mittel/ }))
    expect(body().dataset.phoneTab).toBe('werwas')
  })

  // ⚠️ The chips name what is still missing and jump to the field. On a phone that field may sit
  // in a tab that is not on screen — and a jump that scrolls to a `display: none` element lands
  // nowhere at all, silently. So the chip has to change tabs first.
  it('a «noch offen» chip carries the tab with it', async () => {
    const { body } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Zu «Anwesenheit» springen/ }))
    await waitFor(() => expect(body().dataset.phoneTab).toBe('werwas'))
  })

  // ⚠️ The same box carries WHAT WILL PRINT. The surface unmounts on every hop to
  // Anwesenheit/Mittel/Verlauf — the documented working loop — and the print-section toggles
  // used to be plain state: switch «Einsatzjournal» off, step away to fix a name, come back and
  // the journal is silently back in the PDF, with the answer buried in the ▾ menu.
  // Its own incident id, so the box this writes cannot seed the tests above.
  it('keeps a print section switched off across the hop to another surface', () => {
    const incident = { ...(INCIDENT as object), id: 'i-print' } as typeof INCIDENT
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Weitere Druckoptionen' }))
    const journal = () => screen.getByRole('menuitemcheckbox', { name: 'Einsatzjournal' })

    const first = render(
      <ReportPreflight
        incident={incident} reportMeta={{ alarmiertAt: START.toISOString() }} events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
        mapContentCount={0} onSaveMeta={vi.fn()}
      />,
    )
    openMenu()
    expect(isChecked(journal())).toBe(true)
    fireEvent.click(journal())
    expect(isChecked(journal())).toBe(false)
    first.unmount()

    render(
      <ReportPreflight
        incident={incident} reportMeta={{ alarmiertAt: START.toISOString() }} events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
        mapContentCount={0} onSaveMeta={vi.fn()}
      />,
    )
    openMenu()
    expect(isChecked(journal())).toBe(false)
  })
})


// ── PHONE: Anwesenheit and Material are TABS of the Rapport (18.09.2026) ──
// The phone bar holds five tiles, so those two gave up theirs. They are handed in as NODES —
// the very same AnwesenheitView / MittelView the vertical rail mounts as surfaces of its own —
// and the pair's presence is what tells this surface it is on a folded phone.
describe('Einsatzrapport · the folded phone (Anwesenheit + Material as tabs)', () => {
  const ANW = <div data-testid="anw">die Anwesenheit</div>
  const MIT = <div data-testid="mit">das Material</div>

  function foldedSetup(over: Partial<React.ComponentProps<typeof ReportPreflight>> = {}) {
    const r = render(
      <ReportPreflight
        incident={INCIDENT}
        reportMeta={{ alarmiertAt: START.toISOString() }}
        events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
        mapContentCount={0}
        onSaveMeta={vi.fn()}
        embedAnwesenheit={ANW}
        embedMittel={MIT}
        {...over}
      />,
    )
    return { ...r, body: () => document.querySelector('.report-preflight-body') as HTMLElement | null }
  }

  const tabNames = () =>
    [...document.querySelectorAll('.rp-tabs .useg-btn')].map((b) => b.textContent)
  /** the tab button by its word — scoped to the strip, because «Anwesenheit» and «Material» also
   *  name a round-up row and a print toggle on the page below it */
  const pick = (word: string) => fireEvent.click(
    [...document.querySelectorAll<HTMLElement>('.rp-tabs .useg-btn')].find((b) => b.textContent === word)!,
  )

  // ⚠️ the WORKING order, not the printing order: Anwesenheit and Material are touched all
  // through the Einsatz, Bericht and Beilagen are written at the end of it.
  it('puts Anwesenheit and Material first, ahead of the Rapport\'s own three', () => {
    foldedSetup()
    expect(tabNames()).toEqual(['Anwesenheit', 'Material', 'Bericht', 'Personal & Mittel', 'Beilagen'])
  })

  it('shows neither on a tablet — there they are surfaces of their own', () => {
    setup()
    expect(tabNames()).toEqual(['Bericht', 'Personal & Mittel', 'Beilagen'])
  })

  // The tab does not SHOW a section of the rapport — it mounts the whole surface in place of
  // the body, head and search and all. No fork: one AnwesenheitView, two places it can stand.
  it('mounts the real surface in place of the rapport body', () => {
    const { body } = foldedSetup({ presentIds: new Set(['p1']) })
    expect(body()).not.toBeNull()
    pick('Anwesenheit')
    expect(screen.getByTestId('anw')).toBeTruthy()
    expect(body()).toBeNull()      // the rapport's own page steps aside entirely
    pick('Material')
    expect(screen.queryByTestId('anw')).toBeNull()
    expect(screen.getByTestId('mit')).toBeTruthy()
  })

  // ⚠️ Nobody marked present yet = the crew is arriving and the rapport has nothing in it to
  // read, so the arrival minutes are the only thing this surface is opened for.
  it('opens on «Anwesenheit» while nobody is marked present', () => {
    foldedSetup()
    expect(screen.getByTestId('anw')).toBeTruthy()
  })

  it('opens on «Bericht» once somebody is on scene', () => {
    const { body } = foldedSetup({ presentIds: new Set(['p1', 'p2']) })
    expect(body()?.dataset.phoneTab).toBe('bericht')
  })

  // The Appell is «Rapport → correct a name → away → back», several times over. A return that
  // landed on the default would cost a tap on every single round trip — so the last tab PICKED
  // is remembered, per incident and per device, and survives the surface being unmounted AND
  // a reload (sessionStorage, stamped with the incident — see lib/reportTabs).
  it('re-opens on the last tab used, for this Einsatz', () => {
    const first = foldedSetup({ presentIds: new Set(['p1']) })
    pick('Material')
    expect(screen.getByTestId('mit')).toBeTruthy()
    first.unmount()

    foldedSetup({ presentIds: new Set(['p1']) })
    expect(screen.getByTestId('mit')).toBeTruthy()
  })

  it('does not carry that tab into another Einsatz', () => {
    const first = foldedSetup({ presentIds: new Set(['p1']) })
    pick('Material')
    first.unmount()

    const other = { ...(INCIDENT as object), id: 'i-other' } as typeof INCIDENT
    const { body } = foldedSetup({ incident: other, presentIds: new Set(['p1']) })
    expect(body()?.dataset.phoneTab).toBe('bericht')
  })

  // A memory written on a phone, read after the window was widened: «Anwesenheit» is not in the
  // tablet's strip at all, and selecting it would have shown an empty body.
  it('ignores a remembered tab this device cannot show', () => {
    const first = foldedSetup()
    pick('Material')
    first.unmount()

    const { body } = setup()   // no embeds — the tablet/desktop strip
    expect(body()?.dataset.phoneTab).toBe('bericht')
  })

  // The round-up's «Anwesenheit» row used to navigate to another surface. Where that surface is
  // a tab of this one, it switches to the tab — there is nowhere to navigate to.
  it('the round-up row switches tab instead of leaving the surface', () => {
    const onOpenAnwesenheit = vi.fn()
    foldedSetup({ presentIds: new Set(['p1']), onOpenAnwesenheit })
    pick('Personal & Mittel')
    fireEvent.click(document.querySelector('[data-step="anwesenheit"] .rp-check-main') as HTMLElement)
    expect(onOpenAnwesenheit).not.toHaveBeenCalled()
    expect(screen.getByTestId('anw')).toBeTruthy()
  })

  // …and a deep link from outside (an open-items row, the rail's own redirect) lands on the
  // right tab whether or not the surface is already standing.
  it('answers an outside «open on this tab» ask, live and queued', () => {
    const live = foldedSetup({ presentIds: new Set(['p1']) })
    act(() => requestReportTab('mittel'))
    expect(screen.getByTestId('mit')).toBeTruthy()
    live.unmount()

    act(() => requestReportTab('anwesenheit'))
    foldedSetup({ presentIds: new Set(['p1']) })
    expect(screen.getByTestId('anw')).toBeTruthy()
  })
})
