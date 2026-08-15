// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReportMeta } from '../lib/workspace'

// Only `reportLinks` is stubbed — everything else on the config module (and the rest of the
// rapport) stays real, so this exercises the wiring the station actually gets. What that
// function itself lets through is pinned in lib/deploymentConfig.test.ts.
vi.mock('../lib/deploymentConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/deploymentConfig')>()),
  reportLinks: () => [
    { id: 'getraenke', title: 'Getränke-Konsum', note: 'Nur bei Bezug', url: 'https://forms.test/f?el={einsatzleiter}&anlass={stichwort}&wehr={wehr}' },
    { id: 'schaden', title: 'Schadenmeldung', url: 'https://versicherung.test/melden' },
  ],
  deploymentName: () => 'Feuerwehr Musterdorf',
}))

// ⚠️ Required, not an optimisation: ReportPreflight imports KrokiFramingPanel statically, which
// pulls maplibre-gl into the module graph, and jsdom cannot load it at all — with or without a
// Kroki on screen. The links are a sibling CheckRow, so stubbing it cannot mask a regression.
vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'
import { Overlays } from '../lib/ui'

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

const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: '2026-08-14T19:42:00Z', closed_at: null,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

function setup(over: Partial<React.ComponentProps<typeof ReportPreflight>> & { reportMeta?: ReportMeta } = {}) {
  const onSaveMeta = vi.fn()
  render(
    <ReportPreflight
      incident={INCIDENT}
      events={[]}
      annotatedPlanCount={0}
      truppCount={0}
      attendanceCount={0}
      mittelCount={0}
      mapContentCount={0}
      onSaveMeta={onSaveMeta}
      {...over}
      reportMeta={{ einsatzleiter: 'Hans Muster', ...over.reportMeta }}
    />,
  )
  // ⚠️ Toasts render from an app-level host, not from the surface that raises them. Without it
  // every «no toast was shown» assertion below would pass for the wrong reason.
  render(<Overlays />)
  return { onSaveMeta }
}

const tickOf = (title: string) => screen.getByRole('checkbox', { name: new RegExp(title) })
const oeffnen = () => screen.getAllByRole('button', { name: 'Öffnen' })[0]

/** Come back from the form's tab — this is what raises the «Erledigt?» offer. */
const returnToApp = () => act(() => { document.dispatchEvent(new Event('visibilitychange')) })

describe('Rapport · Formulare & Links', () => {
  it('shows the station’s forms with their notes, and counts what is still open', () => {
    setup()
    expect(screen.getByText('Getränke-Konsum')).toBeTruthy()
    expect(screen.getByText('Nur bei Bezug')).toBeTruthy()
    expect(screen.getByText('0 von 2 erledigt')).toBeTruthy()
  })

  it('⚠️ sits in the Beilagen tab on a phone, beside the Fotos it belongs with', () => {
    // The phone tabs gate by `data-tab` in CSS (see .report-preflight-body[data-phone-tab]),
    // so this attribute IS the wiring — a row that loses it reappears under every tab, and one
    // given the wrong name disappears from the surface without anything failing.
    setup()
    const row = screen.getByText('Getränke-Konsum').closest('.rp-check')
    expect(row?.getAttribute('data-tab')).toBe('beilagen')
    // …the same tab the Fotos card is on
    const fotos = screen.getByText('Fotos').closest('.rp-check')
    expect(fotos?.getAttribute('data-tab')).toBe('beilagen')
  })

  it('ticks a form off into the blob — the app never sets this itself', () => {
    const { onSaveMeta } = setup()
    fireEvent.click(tickOf('Getränke-Konsum'))
    const saved = onSaveMeta.mock.lastCall?.[0] as ReportMeta
    expect(Object.keys(saved.linksDone ?? {})).toEqual(['getraenke'])
    // …and untickable again: a wrong tap on the Rapport must be undoable like everything else
    cleanup()
    const second = setup({ reportMeta: { linksDone: { getraenke: '2026-08-14T21:12:00Z' } } })
    expect(screen.getByText('1 von 2 erledigt')).toBeTruthy()
    fireEvent.click(tickOf('Getränke-Konsum'))
    expect((second.onSaveMeta.mock.lastCall?.[0] as ReportMeta).linksDone).toBeUndefined()
  })

  it('opens the form with the Einsatz already substituted into it', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    setup()
    fireEvent.click(oeffnen())
    expect(open).toHaveBeenCalledWith(
      'https://forms.test/f?el=Hans%20Muster&anlass=Brand%20Geb%C3%A4ude&wehr=Feuerwehr%20Musterdorf',
      '_blank', 'noopener,noreferrer',
    )
    open.mockRestore()
  })

  // The offer waits for the operator to COME BACK. Raised at the press it would sit on a tab
  // that just lost focus and expire (6 s) while the form was still being filled in.
  describe('the «Erledigt?» offer after the form', () => {
    it('is raised on return, and ticks the row off', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(window)
      const { onSaveMeta } = setup()
      fireEvent.click(oeffnen())
      expect(screen.queryByRole('button', { name: 'Erledigt' })).toBeNull() // not yet — still away
      returnToApp()
      fireEvent.click(screen.getByRole('button', { name: 'Erledigt' }))
      expect(Object.keys((onSaveMeta.mock.lastCall?.[0] as ReportMeta).linksDone ?? {})).toEqual(['getraenke'])
      open.mockRestore()
    })

    it('is not offered to a session that may not write (viewer / archived Einsatz)', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(window)
      setup({ canEdit: false })
      fireEvent.click(oeffnen()) // reading the form is not editing — Öffnen stays live
      returnToApp()
      expect(screen.queryByRole('button', { name: 'Erledigt' })).toBeNull()
      open.mockRestore()
    })

    it('is not offered again for a row that is already ticked', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(window)
      setup({ reportMeta: { linksDone: { getraenke: '2026-08-14T21:12:00Z' } } })
      fireEvent.click(oeffnen())
      returnToApp()
      expect(screen.queryByRole('button', { name: 'Erledigt' })).toBeNull()
      open.mockRestore()
    })

    it('⚠️ never claims a blocked popup was opened', () => {
      // window.open returning null and the app saying «geöffnet» anyway would let the checklist
      // record a form that never came up.
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      setup()
      fireEvent.click(oeffnen())
      returnToApp()
      expect(screen.queryByRole('button', { name: 'Erledigt' })).toBeNull()
      expect(screen.getByText(/blockiert/)).toBeTruthy()
      open.mockRestore()
    })
  })
})
