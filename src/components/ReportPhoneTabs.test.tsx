// @vitest-environment jsdom
//
// The phone's three tabs (ReportPreflight · PhoneTab). jsdom applies no stylesheet, so what is
// asserted here is the pair the CSS keys off — `data-phone-tab` on the body and `data-tab` on
// each block — not pixels. That pair IS the mechanism: get it wrong and a section either never
// appears or appears in all three tabs.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

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
    fireEvent.click(screen.getByRole('button', { name: /Wer & Was/ }))
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
