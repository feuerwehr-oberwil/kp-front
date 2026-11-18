// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { HistoryPanel } from './HistoryPanel'
import type { IncidentMeta } from '../../lib/incidents'

// ONE status tag (29.09.2026, owner: «we just need tags to say an emergency is closed. open is
// the default state»): a closed Einsatz says «Abgeschlossen», a running one — «offen» or
// «in_arbeit» to the backend — carries no status tag at all.

const meta = (id: string, over: Partial<IncidentMeta>): IncidentMeta => ({
  id, divera_id: null, title: id, type: null, priority: null, address: null, lat: null, lng: null,
  status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-29T08:00:00Z', closed_at: null, is_archived: false, is_exercise: false,
  report_done_at: null, ...over,
} as IncidentMeta)

vi.mock('../../lib/incidents', async (orig) => ({
  ...(await orig<typeof import('../../lib/incidents')>()),
  listIncidents: vi.fn(async () => [
    meta('Brand A', { status: 'offen' }),
    meta('Brand B', { status: 'in_arbeit' }),
    meta('Brand C', { status: 'abgeschlossen', is_archived: true, started_at: '2026-09-01T08:00:00Z' }),
  ]),
}))

afterEach(cleanup)

describe('HistoryPanel status tags', () => {
  it('tags only the closed Einsatz', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    await screen.findByText('Brand C')
    const tags = [...document.querySelectorAll('.ip-hist .ip-badge')].map((b) => b.textContent)
    expect(tags).toEqual(['Abgeschlossen'])
    expect(screen.queryByText('In Arbeit')).toBeNull()
  })
})

// round 18.11.2026 #2 (owner pick): «Wieder öffnen» wears the ↶ the Verlauf gives «Einsatz
// wiedereröffnet», as «Löschen» beside it wears its bin
describe('HistoryPanel lifecycle buttons', () => {
  it('gives «Wieder öffnen» the reopen glyph', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} onArchive={async () => {}} />)
    await screen.findByText('Brand C')
    const reopen = screen.getByRole('button', { name: appConfig.copy.history.reactivate })
    expect(reopen.querySelector('use')?.getAttribute('href')).toBe('#undo')
  })
})

// button sweep HEADS.4 + HEADS.3 (17.11.2026): «Ernstfall / Übung» and «Einsatzart» are ONE value
// each – a one-of-N with «Alle» first and ticked, never a checkbox that unticks its neighbour
// behind your back – and the narrowed list says what narrows it, with the way back.
describe('HistoryPanel filter', () => {
  it('picks one Art per group and names it in the strip', async () => {
    const h = appConfig.copy.history
    const F = appConfig.copy.filterStrip
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    await screen.findByText('Brand C')
    fireEvent.click(screen.getByRole('button', { name: h.filterAria }))
    const all = await screen.findAllByRole('menuitemradio', { name: h.filterAll })
    expect(all[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: h.filterExercise }))
    await waitFor(() => expect(screen.getByText(F.filtered).parentElement!.textContent).toContain(h.filterExercise))
    expect(screen.queryByText('Brand A')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: F.showAll }))
    await screen.findByText('Brand A')
    expect(screen.queryByText(F.filtered)).toBeNull()
  })
})
