// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
