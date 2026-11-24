// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useJournalWriters, type UseJournalWritersInputs } from './useJournalWriters'
import { createUndoTimeline } from '../lib/undoTimeline'

vi.mock('../lib/ui', () => ({ toast: vi.fn(), undoToast: vi.fn(), confirmDialog: vi.fn() }))
vi.mock('../lib/alarm', async (load) => ({ ...await load<typeof import('../lib/alarm')>(), ensureNotifyPermission: vi.fn(async () => {}) }))

/** The writer over inert stubs; `pushEvent` and `emit` record the row and the audit. */
function writers() {
  const given = {
    pushEvent: vi.fn(), emit: vi.fn(), log: vi.fn(), mode: 'map' as const, timeline: [], running: true,
    undoHist: createUndoTimeline(), composerOpenedAtRef: { current: null }, stepLabelRef: { current: null },
    incidentView: { center: [7.6, 47.5] }, doc: { entities: [], drawings: [] }, building: null, player: null,
    tacticalLocked: false, replayActive: false, activePlanId: 'modul6',
  } satisfies Partial<Omit<UseJournalWritersInputs, 'incidentView'>> & { incidentView: { center: [number, number] } }
  const deps = new Proxy(given, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : (k === 'then' ? undefined : vi.fn())),
  }) as unknown as UseJournalWritersInputs
  const { result } = renderHook(() => useJournalWriters(deps))
  return { addJournal: result.current.addJournal, given }
}

// hunt 24.11.2026, tests-quality F4: a Meldung that moves an existing Pendenz's deadline. The
// tests started from a hand-built `op: 'note'` row, so the writer could mint a new item id – and
// audit a `reminder.create` for an item no row holds – without one of them going red.
describe('addJournal · a Meldung with a due time on an existing Pendenz', () => {
  it('writes the note on THAT item, and audits one `reminder.note` with its new deadline', () => {
    const { addJournal, given } = writers()
    const dueAt = '2026-11-24T21:20:00.000Z'
    addJournal({ text: 'Werkhof meldet 20 Minuten', noteFor: { id: 'p1' }, dueAt })
    expect(given.pushEvent).toHaveBeenCalledOnce()
    expect(given.pushEvent.mock.calls[0][0].reminder).toEqual({ op: 'note', id: 'p1', dueAt })
    const reminderEvents = given.emit.mock.calls.filter(([op]) => String(op).startsWith('reminder.'))
    expect(reminderEvents).toEqual([['reminder.note', { id: 'p1', dueAt }]])
  })
})
