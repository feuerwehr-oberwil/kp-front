// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReportPreflight } from './ReportPreflight'
import { Overlays } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import type { IncidentMeta } from '../lib/incidents'
import { enqueuePrint } from '../lib/printRelay'

// The «Angaben fehlen noch» ask in front of Ausdrucken (14.09.): it used to list the open points as
// plain text, so the operator closed it and hunted for the section. Each point is now a row that
// goes there — the same jump the «noch offen» chip makes — and going there is NOT going ahead.
// Pinned: the rows are there, tapping one closes the ask, scrolls the sheet to the step and
// focuses its field, and nothing was sent to the printer.

vi.mock('../lib/printRelay', async (orig) => ({
  ...(await orig<typeof import('../lib/printRelay')>()),
  // the Ausdrucken button only renders with a relay that says it is there
  fetchPrintStatus: vi.fn(async () => ({ available: true, online: true })),
  prewarmPrint: vi.fn(async () => {}),
  enqueuePrint: vi.fn(async () => 'job-1'),
}))
vi.mock('../lib/incidents', async (orig) => ({
  ...(await orig<typeof import('../lib/incidents')>()),
  verifyChain: vi.fn(async () => ({ intact: true, broken_at_seq: null, count: 0, head: null })),
  getIncident: vi.fn(async () => ({ text: '' })),
}))
vi.mock('../lib/replay', async (orig) => ({
  ...(await orig<typeof import('../lib/replay')>()),
  loadReplay: vi.fn(async () => ({ events: [] })),
}))

const A = appConfig.copy.abschluss
const R = appConfig.copy.printRelay

const incident: IncidentMeta = {
  id: 'inc-1', divera_id: null, title: 'Brand klein', type: null, priority: null, address: null,
  lat: null, lng: null, status: 'open', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-14T08:00:00.000Z', closed_at: null, is_archived: false, is_exercise: false,
  report_done_at: null, workspace_rev: 1, created_by: null,
  created_at: '2026-09-14T08:00:00.000Z', updated_at: '2026-09-14T08:00:00.000Z',
}

const scrollTo = vi.fn()
beforeEach(() => {
  // useIsPhone → matchMedia, which jsdom does not implement; pinned to «not a phone»
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  scrollTo.mockReset()
  vi.mocked(enqueuePrint).mockClear()
  // jsdom has no scrollTo on elements, and the jump measures a frame after switching tabs —
  // run the frames now so the whole jump lands inside the click
  Element.prototype.scrollTo = scrollTo as unknown as Element['scrollTo']
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ReportPreflight · Ausdrucken with missing Mindestangaben', () => {
  it('lists the open points as rows; tapping one closes the ask and jumps to the step without printing', async () => {
    render(
      <>
        <Overlays />
        <ReportPreflight
          incident={incident} reportMeta={{}} events={[]}
          annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
          onSaveMeta={() => {}}
        />
      </>,
    )
    // ⚠️ Settle, then query ONCE: no findBy/waitFor polling. The mocked loaders (print relay,
    // chain, Einsatz text) resolve at once; flushed inside act() the button is simply there. Polled,
    // the first check always FAILED (the button waits on the relay status), and a failing role query
    // renders the whole document into its error before the second, successful one runs. There is no
    // race here, only CPU: ~0.5 s idle, the first role query in a worker alone ~0.2 s (jsdom's
    // getComputedStyle warming up). It crossed the 5 s limit (5.1 s) on a machine running several
    // full suites at once (25.09.2026); the dropped work is a third of it.
    await act(async () => {})
    const print = screen.getByRole('button', { name: R.send })
    await act(async () => { fireEvent.click(print) })

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain(appConfig.copy.preflight.exportIncompleteTitle)
    // the open point is a BUTTON in the list, not a bullet
    const row = within(dialog).getByRole('button', { name: A.steps.kurzbericht })
    expect(row.closest('.confirm-list')).toBeTruthy()

    await act(async () => { fireEvent.click(row) })

    expect(screen.queryByRole('alertdialog')).toBeNull()
    // the sheet scrolled to the step and its field holds the focus
    expect(scrollTo).toHaveBeenCalled()
    const target = document.querySelector<HTMLElement>('[data-step="kurzbericht"]')
    expect(target?.classList.contains('rp-flash')).toBe(true)
    expect(target?.contains(document.activeElement)).toBe(true)
    // going there is not going ahead
    expect(enqueuePrint).not.toHaveBeenCalled()
  })
})
