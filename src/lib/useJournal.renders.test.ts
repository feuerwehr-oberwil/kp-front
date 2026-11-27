// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineEvent } from '../types'

// What one Meldung costs the workspace: how often the journal hook makes it render, and how often
// it rebuilds the Verlauf (`display`). The live-follow loop is captured, not run, so each round is
// played by hand – the store underneath is the real one, on fake IndexedDB and a fake server.
const { apiGet, apiPost, apiBeacon, rounds } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiBeacon: vi.fn(),
  rounds: [] as ((o: { hidden: boolean; signal: AbortSignal }) => Promise<boolean>)[],
}))
vi.mock('./deviceName', () => ({ deviceName: () => undefined }))
vi.mock('./api', async () => ({ ...await vi.importActual<typeof import('./api')>('./api'), apiGet, apiPost, apiBeacon }))
vi.mock('./useLongPoll', () => ({ useLongPoll: (o: { round: (typeof rounds)[number] }) => { rounds.push(o.round) } }))

import { __resetIdbForTests } from './idb'
import { JournalStore } from './journalStore'
import { useJournal } from './useJournal'

const row: TimelineEvent = { id: 'm1', t: '14:00', at: '2026-07-02T14:00:00Z', icon: 'flag', text: 'Meldung' }
const settle = async () => { for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0))) }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  rounds.length = 0
  const server: { seq: number; row: TimelineEvent }[] = []
  apiPost.mockReset().mockImplementation(async (_p: string, body: { entries: TimelineEvent[] }) => {
    const fresh = body.entries.filter((e) => !server.some((s) => s.row.id === e.id)).map((e) => ({ seq: server.length + 1, row: e }))
    server.push(...fresh)
    return { entries: fresh, latest_seq: server.length }
  })
  // every pull answers with every row: the drain's pull and a long-poll wake both bring back
  // the row this device already holds
  apiGet.mockReset().mockImplementation(async () => ({ entries: [...server], latest_seq: server.length }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useJournal – renders per Meldung', () => {
  it('one Meldung end to end renders the workspace twice and builds the Verlauf twice', async () => {
    const display = vi.spyOn(JournalStore.prototype, 'display')
    let renders = 0
    const hook = renderHook(() => { renders++; return useJournal({ incidentId: 'i1', readOnly: false, legacy: [] }) })
    await settle() // hydrated, first (empty) pull answered
    renders = 0
    display.mockClear()

    act(() => hook.result.current.append(row)) // the row shows, «wird gespeichert»
    expect(hook.result.current.unsentIds.has('m1')).toBe(true)
    await settle() // write lands → POST answered → write lands → the drain's pull brings m1 back
    expect(hook.result.current.syncStatus).toBe('synced')
    expect(hook.result.current.unsentIds.size).toBe(0)
    await act(() => rounds[0]({ hidden: false, signal: new AbortController().signal })) // long-poll wake: m1 again
    await settle()

    expect(hook.result.current.rows.map((r) => r.id)).toEqual(['m1'])
    expect({ renders, display: display.mock.calls.length }).toEqual({ renders: 2, display: 2 })
  })
})
