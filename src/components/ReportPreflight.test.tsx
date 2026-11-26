// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReportPreflight } from './ReportPreflight'
import { Overlays } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import type { IncidentMeta } from '../lib/incidents'
import { downloadDirectReportPdf, signedPartOf } from '../lib/reportPdfDirect'
import { sha256Hex, type ReportSignature } from '../lib/reportSignature'
import { fetchPrintStatus } from '../lib/printRelay'
import type { Person, Trupp } from '../types'

// The «Angaben fehlen noch» ask in front of the Rapport-PDF (14.09.): it used to list the open
// points as plain text, so the operator closed it and hunted for the section. Each point is now a
// row that goes there — the same jump the «noch offen» chip makes — and going there is NOT going
// ahead. Pinned: the rows are there, tapping one closes the ask, scrolls the sheet to the step and
// focuses its field, and no PDF was made.

vi.mock('../lib/reportPdfDirect', async (orig) => {
  const real = await orig<typeof import('../lib/reportPdfDirect')>()
  // spied, not replaced: a signature test reads back what the Rapport hashes
  return { ...real, downloadDirectReportPdf: vi.fn(async () => {}), signedPartOf: vi.fn(real.signedPartOf) }
})
// no station printer here: the relay answers «not configured», so the head carries the PDF only
vi.mock('../lib/printRelay', async (orig) => ({
  ...(await orig<typeof import('../lib/printRelay')>()),
  fetchPrintStatus: vi.fn(async () => null),
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

// round 18.11.2026 #3: a folded «Drucken» stacks like «PDF» beside it. The head's fold (13-incident ·
// «fold») turns a tile's DIRECT children into a column, so the glyph + relay dot are one child and
// the words are their siblings – inside the glyph's span «Drucken» stayed beside the printer.
describe('ReportPreflight · the print tile', () => {
  it('keeps the printer and its dot together, the words beside them as the tile\'s own children', async () => {
    vi.mocked(fetchPrintStatus).mockResolvedValueOnce({ available: true, online: true })
    render(
      <ReportPreflight
        incident={incident} reportMeta={{}} events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
        onSaveMeta={() => {}}
      />,
    )
    await act(async () => {})
    const tile = document.querySelector<HTMLElement>('.rp-head-actions .print-send')!
    const glyphs = tile.querySelector(':scope > .print-send-main')!
    expect(glyphs.querySelector('.print-relay-dot')).not.toBeNull()
    expect(glyphs.querySelector('.fold-long, .fold-short')).toBeNull()
    expect(tile.querySelector(':scope > .fold-long')?.textContent).toBe(appConfig.copy.printRelay.send)
    expect(tile.querySelector(':scope > .fold-short')?.textContent).toBe(appConfig.copy.printRelay.sendShort)
  })
})

// ENT.9 (17.11.2026): the PDF printed «ÜBUNG» while the screen the EL signed on said nothing
describe('ReportPreflight · an Übung', () => {
  it('wears the Übung tag in its head, and a real Einsatz does not', async () => {
    const props = { reportMeta: {}, events: [], annotatedPlanCount: 0, truppCount: 0, attendanceCount: 1, mittelCount: 1, onSaveMeta: () => {} }
    render(<ReportPreflight incident={{ ...incident, is_exercise: true }} {...props} />)
    await act(async () => {})
    expect(document.querySelector('.rp-head h2 .ip-badge-exercise')?.textContent).toBe(appConfig.copy.exerciseBadge)
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('aria-label')).toContain(appConfig.copy.exerciseBadge)
    cleanup()
    render(<ReportPreflight incident={incident} {...props} />)
    await act(async () => {})
    expect(document.querySelector('.rp-head .ip-badge-exercise')).toBeNull()
  })
})

// owner, 31.10.2026: the pencil went – the card is the pointer's target, its heading the keyboard's
describe('ReportPreflight · the Einsatzdaten card', () => {
  it('opens from the keyboard on its heading, even where the Rapport itself may not be written', async () => {
    const onEditDispatch = vi.fn()
    render(
      <ReportPreflight
        incident={incident} reportMeta={{}} events={[]} canEdit={false}
        annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
        onSaveMeta={() => {}} onEditDispatch={onEditDispatch}
      />,
    )
    await act(async () => {})
    const head = screen.getByRole('button', { name: P.fromDispatch })
    fireEvent.keyDown(head, { key: 'Enter' })
    fireEvent.keyDown(head, { key: ' ' })
    fireEvent.keyDown(head, { key: 'Tab' })
    expect(onEditDispatch).toHaveBeenCalledTimes(2)
    // a pointer tap anywhere on the card is ONE ask
    fireEvent.click(head)
    expect(onEditDispatch).toHaveBeenCalledTimes(3)
  })

  // owner C1, 05.11.2026: a missing REQUIRED fact warns where it stands; an optional one stays quiet
  it('marks a missing Ort as a warning and leaves a missing Alarmmeldung faint', async () => {
    render(
      <ReportPreflight
        incident={incident} reportMeta={{}} events={[]} canEdit={false}
        annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
        onSaveMeta={() => {}}
      />,
    )
    await act(async () => {})
    const valueOf = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.firstElementChild
    expect(valueOf(P.ort)).toHaveProperty('className', 'report-meta-missing')
    expect(valueOf(P.alarmMessage)).toHaveProperty('className', 'report-meta-empty')
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

  // ⚠️ UNTICKED whatever the record holds (owner, 10.10.2026) — it was seeded «ticked when a crew
  // went in under PA» on 09.10.; an internal debrief sheet is asked for, not handed out
  it.each([
    ['no-crew', []],
    ['standby', [crew([{ t: '2026-09-14T08:20:00.000Z', bar: 300, kind: 'registered' }])]],
    ['pa-entry', [crew(entry)]],
    ['basic-entry', [{ ...crew(entry), kind: 'einfach' as const }]],
  ] as const)('opens the print checkbox unticked for %s', async (id, trupps) => {
    render(sheet(`f7-default-${id}`, [...trupps]))
    expect((await openMenu()).getAttribute('aria-checked')).toBe('false')
  })

  it.each([1, 2])('keeps the operator\'s choice after %i tap(s) across a reopening with changed crew data', async (taps) => {
    const id = `f7-override-${taps}`
    const mounted = render(sheet(id, []))
    const toggle = await openMenu()
    for (let i = 0; i < taps; i++) await act(async () => { fireEvent.click(toggle) })
    const chosen = String(taps % 2 === 1)
    expect(toggle.getAttribute('aria-checked')).toBe(chosen)
    mounted.unmount()
    render(sheet(id, [crew(entry)]))
    expect((await openMenu()).getAttribute('aria-checked')).toBe(chosen)
  })
})

// owner, 12.11.2026: closed is closed – the Rapport too – and ONE strip says what is next
describe('ReportPreflight · a CLOSED Einsatz', () => {
  const closedAt = '2026-09-14T10:00:00.000Z'
  const C = appConfig.copy.archived
  const renderClosed = (id: string, extra: Partial<Parameters<typeof ReportPreflight>[0]> = {}) => render(
    <ReportPreflight
      incident={{ ...incident, id, is_archived: true, closed_at: closedAt }} reportMeta={{}} events={[]} canEdit closed
      annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
      onSaveMeta={() => {}} {...extra}
    />,
  )

  it('locks the form and offers «Wieder öffnen» in the one strip', async () => {
    const onReopen = vi.fn(async () => 'ok' as const)
    renderClosed('closed-a', { onReopen })
    expect(await screen.findByText(C.rapportClosedHint)).toBeTruthy()
    const fieldsets = [...document.querySelectorAll<HTMLFieldSetElement>('.report-fieldset')]
    expect(fieldsets.length).toBeGreaterThan(0)
    expect(fieldsets.every((f) => f.disabled)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: C.reactivate }))
    expect(onReopen).toHaveBeenCalledTimes(1)
  })

  it('says «nur ansehen» where this session cannot reopen', async () => {
    renderClosed('closed-b')
    expect(await screen.findByText(C.rapportClosedViewOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.reactivate })).toBeNull()
  })

  it('asks for no signature: the closed strip is the only one, signing or not', async () => {
    renderClosed('closed-c', { onSign: () => {}, onReopen: async () => 'ok' as const })
    expect(await screen.findByText(C.rapportClosedHint)).toBeTruthy()
    expect(document.querySelectorAll('.rp-strip, .rp-band')).toHaveLength(1)
  })
})

// A signature holds while the signed part is unchanged – checked against the content itself, so
// an edit that keeps every count (a renamed person, a reworded line) still makes it «ungültig»,
// and the paper never carries a signature the content no longer matches.
describe('ReportPreflight · a signature after an edit', () => {
  const at = '2026-09-14T08:05:00.000Z'
  const person = (displayName: string): Person => ({ id: 'p1', displayName, active: true, updatedAt: at })
  const sheet = (displayName: string, sigs: ReportSignature[]) => (<>
    <Overlays />
    <ReportPreflight
      incident={{ ...incident, id: 'sig-edit' }} reportMeta={{ summary: 'Küche' }} events={[]}
      personnel={[person(displayName)]} attendance={{ p1: { status: 'present', checkedInAt: at, displayNameSnapshot: 'Amrein Patrick' } }}
      annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
      onSaveMeta={() => {}} onSign={() => {}} reportSignatures={sigs}
    />
  </>)
  const signed = (scope: string): ReportSignature => ({
    id: 'g1', role: 'el', name: 'Amrein Patrick', at, scope, strokes: { w: 100, h: 40, d: [[1, 1, 50, 30]] },
  })
  const S = appConfig.copy.signature

  it('goes «ungültig» on a renamed person and leaves the printed line empty', async () => {
    const view = render(sheet('Amrein Patrick', [signed('0'.repeat(64))]))
    // the part is hashed (WebCrypto, a later task): a scope of zeros is then «ungültig»
    await waitFor(() => expect(screen.getAllByText(S.invalid).length).toBeGreaterThan(0))
    // sign the content exactly as it stands
    const results = vi.mocked(signedPartOf).mock.results
    const part = results[results.length - 1].value as string
    view.rerender(sheet('Amrein Patrick', [signed(await sha256Hex(part))]))
    // the same part, its hash already known: valid in this render
    expect(screen.queryByText(S.invalid)).toBeNull()

    view.rerender(sheet('Amrein Peter', [signed(await sha256Hex(part))]))
    await waitFor(() => expect(screen.getAllByText(S.invalid).length).toBeGreaterThan(0))

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: P.pdfFull })) })
    // the Mindestangaben ask: make it anyway
    const ask = screen.getByRole('alertdialog')
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: P.pdfFull })) })
    const calls = vi.mocked(downloadDirectReportPdf).mock.calls
    expect(calls[calls.length - 1][0].signatures).toEqual([])
  })
})

// Opening the Rapport is read-only (owner, UX journeys sign-off, 25.11.2026): the Kroki's
// Einsatzleiter is shown, not stored, and the roster person it names is not filed onto the
// Anwesenheit. Until then the first look wrote both, and the Verlauf said «Rapportangaben: …».
describe('ReportPreflight · opening the Rapport', () => {
  it('writes nothing – the Kroki-named Einsatzleiter only shows', async () => {
    const writes = { onSaveMeta: vi.fn(), onRolePicked: vi.fn(), onAddGuest: vi.fn(), onSign: vi.fn(), onResolveConflict: vi.fn() }
    const el = { id: 'el', kind: 'symbol', layer: 'taktisch', coord: [7, 47], symbol: appConfig.symbols.einsatzleiterSymbols[0], fields: { Name: 'Hofer Simon' } }
    const hofer = { id: 'p-hofer', displayName: 'Hofer Simon' } as Person
    render(
      <ReportPreflight
        incident={incident} reportMeta={{}} events={[]} scene={{ entities: [el], drawings: [] } as never} mapContentCount={0}
        annotatedPlanCount={0} truppCount={0} attendanceCount={1} mittelCount={1}
        personnel={[hofer]} attendance={{}}
        {...writes}
      />,
    )
    await act(async () => {})
    expect(document.querySelector('[data-step="einsatzleiter"]')?.textContent).toContain('Hofer Simon')
    for (const spy of Object.values(writes)) expect(spy).not.toHaveBeenCalled()
  })
})
