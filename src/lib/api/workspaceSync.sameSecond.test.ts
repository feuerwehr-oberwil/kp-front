import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordConflict } from '../mergeWorkspace'
import type { AttendanceEntry, Shift } from '../../types'

// staging r4 D3 (25.09.2026): two devices save DIFFERENT fields of the same person or the same
// shift within one second. Both saves are built on the same revision; the first lands, the second
// 409s and merges against that shared ancestor. Merged as whole objects, «both changed» went to
// the second device's entry and the first device's field was gone — silently for a shift, and
// with a false «zwei Funktionen … unterschiedliche Zeiten – bitte prüfen» row for the Anwesenheit.
//
// Two REAL `WorkspaceSync` engines against one in-memory server that keeps the blob the way the
// backend does: a PUT at a stale base_rev is a 409, and what is stored comes back with its keys
// re-sorted (JSONB).

type Ws = { attendance?: Record<string, AttendanceEntry>; shifts?: Shift[] }

const server = vi.hoisted(() => ({ ws: {} as Record<string, unknown>, rev: 0, conflicts: 0 }))

vi.mock('./workspace', async () => {
  const { ApiError } = await import('../api')
  const { serverRoundTrip } = await import('../jsonb.test-utils')
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20))
  return {
    getWorkspace: async () => {
      await wait()
      return { workspace: structuredClone(server.ws), workspace_rev: server.rev }
    },
    putWorkspace: async (_id: string, ws: Record<string, unknown>, baseRev: number) => {
      await wait()
      if (baseRev !== server.rev) { server.conflicts++; throw new ApiError(409, 'Workspace wurde zwischenzeitlich geändert') }
      server.rev += 1
      server.ws = serverRoundTrip(structuredClone(ws))
      const rev = server.rev
      await wait()
      return { workspace: null, workspace_rev: rev }
    },
    putWorkspaceBeacon: () => {},
    putWorkspaceTrupps: () => { throw new Error('not in this test') },
    putWorkspaceTruppsBeacon: () => {},
    putWorkspaceRecord: () => { throw new Error('not in this test') },
    putWorkspaceRecordBeacon: () => {},
  }
})
vi.mock('../idb', () => ({
  idbGet: vi.fn(async () => null),
  idbRead: vi.fn(async () => ({ ok: true, value: null })),
  idbSet: vi.fn(async () => true),
  idbDel: vi.fn(async () => undefined),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { WorkspaceSync } = await import('./workspaceSync')
const { serverRoundTrip } = await import('../jsonb.test-utils')
const { conflictWhat } = await import('../attendanceConflict')

const emil: AttendanceEntry = {
  status: 'present', displayNameSnapshot: 'Tst Emil', checkedInAt: '2026-09-25T21:36:00Z',
  intervals: [{ from: '2026-09-25T21:36:00Z' }], ort: 'scene', source: 'kp',
}
const shift: Shift = { id: 'sh1', personId: 'p1', from: '2026-09-25T23:00:00Z', to: '2026-09-26T04:00:00Z', bandId: 'bd1' }

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(server, { ws: serverRoundTrip({ attendance: { p1: emil }, shifts: [shift] }), rev: 1, conflicts: 0 })
})
afterEach(() => { vi.useRealTimers() })

/** Two devices on the same revision, each makes ONE edit, both saves go out in the same moment. */
async function sameSecond(editA: (ws: Ws) => Ws, editB: (ws: Ws) => Ws) {
  const devices = ['a', 'b'].map((d) => {
    const sync = new WorkspaceSync(`incident-${d}`, { debounceMs: 300 })
    const dev = { sync, local: {} as Ws, conflicts: [] as RecordConflict[] }
    sync.onApplyMerged = (ws) => { dev.local = ws as Ws }
    sync.onAttendanceConflicts = (c) => { dev.conflicts.push(...c) }
    return dev
  })
  const opened = Promise.all(devices.map((dev) => dev.sync.init()))
  await vi.advanceTimersByTimeAsync(100)
  for (const [i, { workspace }] of (await opened).entries()) devices[i].local = (workspace ?? {}) as Ws
  const [a, b] = devices
  a.local = editA(a.local); a.sync.save(a.local as never)
  b.local = editB(b.local); b.sync.save(b.local as never)
  for (let i = 0; i < 100 && devices.some((dev) => dev.sync.hasUnsynced); i++) await vi.advanceTimersByTimeAsync(100)
  expect(devices.some((dev) => dev.sync.hasUnsynced)).toBe(false)
  expect(server.conflicts).toBeGreaterThan(0) // the second save really went through the 409 merge
  for (const dev of devices) dev.sync.dispose()
  return { ws: server.ws as Ws, conflicts: [...a.conflicts, ...b.conflicts] }
}

// the edits as the Anwesenheit and the Zeitplan write them: a fresh object with the field changed
const setVon = (from: string) => (ws: Ws): Ws => ({
  ...ws, attendance: { ...ws.attendance, p1: { ...ws.attendance!.p1, checkedInAt: from, intervals: [{ from }], source: 'kp' } },
})
const setNote = (note: string, at: string) => (ws: Ws): Ws => ({
  ...ws, attendance: { ...ws.attendance, p1: { ...ws.attendance!.p1, note, noteAt: at, source: 'kp' } },
})
const setShift = (patch: Partial<Shift>) => (ws: Ws): Ws => ({
  ...ws, shifts: ws.shifts!.map((s) => (s.id === 'sh1' ? { ...s, ...patch } : s)),
})

describe('WorkspaceSync · two devices save different fields of one record in the same second (staging r4 D3)', () => {
  it('Anwesenheit: A\'s «von» and B\'s Bemerkung both survive, and no «bitte prüfen» row is raised', async () => {
    const { ws, conflicts } = await sameSecond(setVon('2026-09-25T21:38:00Z'), setNote('Fahrer TLF', '2026-09-25T21:38:30Z'))
    expect(ws.attendance!.p1).toMatchObject({ checkedInAt: '2026-09-25T21:38:00Z', intervals: [{ from: '2026-09-25T21:38:00Z' }], note: 'Fahrer TLF' })
    expect(conflicts).toEqual([])
  })

  it('Zeitplan: A\'s «von» and B\'s «bis» on one shift both survive', async () => {
    const { ws } = await sameSecond(setShift({ from: '2026-09-26T01:00:00Z' }), setShift({ to: '2026-09-26T07:00:00Z' }))
    expect(ws.shifts).toEqual([{ ...shift, from: '2026-09-26T01:00:00Z', to: '2026-09-26T07:00:00Z' }])
  })

  it('Zeitplan: «eingeteilt» and «bis» both survive', async () => {
    const { ws } = await sameSecond(setShift({ confirmed: true }), setShift({ to: '2026-09-26T06:00:00Z' }))
    expect(ws.shifts).toEqual([{ ...shift, confirmed: true, to: '2026-09-26T06:00:00Z' }])
  })

  it('a real same-field divergence still reports — and its row names only that field', async () => {
    const { ws, conflicts } = await sameSecond(
      (w) => setNote('Maschinist', '2026-09-25T21:40:00Z')(setVon('2026-09-25T21:42:00Z')(w)),
      setNote('Maschinist TLF', '2026-09-25T21:40:01Z'),
    )
    // A's time is not part of the divergence: it stands whichever Funktion won
    expect(ws.attendance!.p1.checkedInAt).toBe('2026-09-25T21:42:00Z')
    expect(conflicts).toHaveLength(1)
    expect(conflictWhat(conflicts[0])).toBe('zwei Funktionen – «Maschinist TLF» und «Maschinist»')
  })
})
