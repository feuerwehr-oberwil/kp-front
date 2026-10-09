// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReportPreflight } from './ReportPreflight'
import { Overlays } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import type { IncidentMeta } from '../lib/incidents'
import { downloadDirectReportPdf } from '../lib/reportPdfDirect'
import type { Trupp } from '../types'

// The «Angaben fehlen noch» ask in front of the Rapport-PDF (14.09.): it used to list the open
// points as plain text, so the operator closed it and hunted for the section. Each point is now a
// row that goes there — the same jump the «noch offen» chip makes — and going there is NOT going
// ahead. Pinned: the rows are there, tapping one closes the ask, scrolls the sheet to the step and
// focuses its field, and no PDF was made.

vi.mock('../lib/reportPdfDirect', async (orig) => ({
  ...(await orig<typeof import('../lib/reportPdfDirect')>()),
  downloadDirectReportPdf: vi.fn(async () => {}),
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
const P = appConfig.copy.preflight

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
  vi.mocked(downloadDirectReportPdf).mockClear()
  // jsdom has no scrollTo on elements, and the jump measures a frame after switching tabs —
  // run the frames now so the whole jump lands inside the click
  Element.prototype.scrollTo = scrollTo as unknown as Element['scrollTo']
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ReportPreflight · the PDF with missing Mindestangaben', () => {
  it('lists the open points as rows; tapping one closes the ask and jumps to the step without a PDF', async () => {
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
    // ⚠️ Settle, then query ONCE: no findBy/waitFor polling. The mocked loaders (chain, Einsatz
    // text) resolve at once; flushed inside act() the button is simply there. A failing role query
    // renders the whole document into its error before a second, successful one would run. There is no
    // race here, only CPU: ~0.5 s idle, the first role query in a worker alone ~0.2 s (jsdom's
    // getComputedStyle warming up). It crossed the 5 s limit (5.1 s) on a machine running several
    // full suites at once (25.09.2026); the dropped work is a third of it.
    await act(async () => {})
    const pdf = screen.getByRole('button', { name: P.pdfFull })
    await act(async () => { fireEvent.click(pdf) })

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
    expect(downloadDirectReportPdf).not.toHaveBeenCalled()
  })
})

describe('ReportPreflight · Auswertung default and operator choice', () => {
  const crew = (readings: Trupp['readings']): Trupp => ({
    id: 't1', no: 1, name: 'Meier Anna', entryPressureBar: 300,
    entryTime: '', lastContactTime: '', status: 'raus', readings,
  })
  const entry: Trupp['readings'] = [{ t: '2026-09-14T08:30:00.000Z', bar: 300, kind: 'entry' }]
  function sheet(id: string, trupps: Trupp[]) {
    return <ReportPreflight incident={{ ...incident, id }} reportMeta={{}} events={[]}
      annotatedPlanCount={0} truppCount={trupps.length} trupps={trupps}
      attendanceCount={0} mittelCount={0} onSaveMeta={() => {}} />
  }
  async function openMenu() {
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: appConfig.copy.preflight.printMenu })) })
    return screen.getByRole('menuitemcheckbox', { name: appConfig.copy.preflight.toggleAuswertung })
  }

  it.each([
    ['no-crew', [], false],
    ['standby', [crew([{ t: '2026-09-14T08:20:00.000Z', bar: 300, kind: 'registered' }])], false],
    ['pa-entry', [crew(entry)], true],
    ['basic-entry', [{ ...crew(entry), kind: 'einfach' as const }], false],
  ] as const)('seeds the print checkbox for %s', async (id, trupps, checked) => {
    render(sheet(`f7-default-${id}`, [...trupps]))
    expect((await openMenu()).getAttribute('aria-checked')).toBe(String(checked))
  })

  it.each([true, false])('keeps an explicit %s choice after reopening with changed crew data', async (initial) => {
    const id = `f7-override-${initial}`
    const mounted = render(sheet(id, initial ? [crew(entry)] : []))
    const toggle = await openMenu()
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.getAttribute('aria-checked')).toBe(String(!initial))
    mounted.unmount()
    render(sheet(id, initial
      ? [{ ...crew(entry), removedAt: '2026-09-14T09:00:00.000Z' }]
      : [crew([{ t: '2026-09-14T08:20:00.000Z', bar: 300, kind: 'registered' }])]))
    expect((await openMenu()).getAttribute('aria-checked')).toBe(String(!initial))
  })

  it('refreshes an untouched default when a PA deployment starts between openings', async () => {
    const id = 'f7-refresh-default'
    const mounted = render(sheet(id, []))
    expect((await openMenu()).getAttribute('aria-checked')).toBe('false')
    mounted.unmount()
    render(sheet(id, [crew(entry)]))
    expect((await openMenu()).getAttribute('aria-checked')).toBe('true')
  })
})

describe('ReportPreflight · a CLOSED Einsatz (staging r3, F10)', () => {
  // The Abschluss promises «Spätere Korrekturen bleiben möglich und erscheinen als Nachträge», and
  // the server takes Rapport writes after the close: the fields stay editable, and one line at
  // the top says the changes are Nachträge — no fields that look open and do nothing.
  it('stays editable and says so in one line at the top', async () => {
    const closed = { ...incident, is_archived: true, closed_at: '2026-09-14T10:00:00.000Z' }
    render(
      <ReportPreflight
        incident={closed} reportMeta={{}} events={[]} canEdit closedHint
        annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
        onSaveMeta={() => {}}
      />,
    )
    expect(await screen.findByText(appConfig.copy.archived.rapportClosedHint)).toBeTruthy()
    const fieldsets = [...document.querySelectorAll<HTMLFieldSetElement>('.report-fieldset')]
    expect(fieldsets.length).toBeGreaterThan(0)
    expect(fieldsets.every((f) => !f.disabled)).toBe(true)
  })
})
