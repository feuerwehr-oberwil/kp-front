// Two tabs of one browser on one Einsatz (hunt 24.11.2026, offline-sync F1 and the three holes of
// the reverted first fix): handing the edit lock over never erases an edit a tab had saved. Each
// «tab» is its own IncidentSelection over the shared IndexedDB and one Web Locks double; the view
// is played by the test (it edits only while the selection says `editing`, and shows the engine's
// workspace after a grant – what useIncidentSync's hand-over does, tested there).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { ApiError } from './api'
import type { IncidentMeta } from './api/incidents'
import * as workspaceApi from './api/workspace'
import { CACHE_DEBOUNCE_MS, setWorkspaceCacheOwner, type WorkspaceSync } from './api/workspaceSync'
import * as idb from './idb'
import { idbGet } from './idb'
import { IncidentSelection } from './incidentSelection'
import { FakeLocks } from './webLocks.test-utils'
import type { Saved } from './workspace'

vi.mock('./api/incidents', async (importOriginal) => ({ ...await importOriginal<typeof import('./api/incidents')>(), getIncident: vi.fn() }))

const baseline: Saved = { entities: [], drawings: [], recent: [], layerState: [], timeline: [] }
const offline = new ApiError(0, 'offline')
type Stored = { workspace: Saved; dirty: boolean }
const slot = async (id: string) => idbGet<Stored>(`kp-front-ws-${id}`)
const settle = () => vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 50)
let n = 0
const tabs: IncidentSelection[] = []

/** One tab with Einsatz `id` open. */
async function tab(id: string) {
  const selection = new IncidentSelection()
  tabs.push(selection)
  await selection.open(id, { id } as IncidentMeta, { debounceMs: 1_000 })
  return selection
}
const engine = (t: IncidentSelection) => t.current as WorkspaceSync
/** The view's edit: what the screen shows plus one change, saved only by an editing tab. */
function edit(t: IncidentSelection, change: Partial<Saved>) {
  if (!t.editing) throw new Error('read-only tab edited')
  const shown = engine(t).workspace as Saved
  engine(t).save({ ...shown, ...change, reportMeta: { ...shown.reportMeta, ...change.reportMeta } })
}

let get: MockInstance<typeof workspaceApi.getWorkspace>
let put: MockInstance<typeof workspaceApi.putWorkspace>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  setWorkspaceCacheOwner('operator')
  get = vi.spyOn(workspaceApi, 'getWorkspace').mockResolvedValue({ workspace: baseline, workspace_rev: 1 })
  put = vi.spyOn(workspaceApi, 'putWorkspace').mockRejectedValue(offline)
  n++
})
afterEach(() => {
  for (const t of tabs.splice(0)) t.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis.navigator, 'locks')
  Reflect.deleteProperty(globalThis.navigator, 'onLine')
})

it('offline-sync F1: the tab that takes over after a close keeps the closed tab’s saved edit', async () => {
  const id = `f1-${n}`
  const a = await tab(id)
  const b = await tab(id)
  expect([a.editing, b.editing]).toEqual([true, false])
  get.mockRejectedValue(offline)
  edit(a, { reportMeta: { remarks: 'from A' } })
  await settle()
  expect(await slot(id)).toMatchObject({ dirty: true, workspace: { reportMeta: { remarks: 'from A' } } })
  a.close() // the lock goes to B once A's last write settled
  await vi.waitFor(() => expect(b.editing).toBe(true))
  edit(b, { reportMeta: { summary: 'from B' } })
  await settle()
  expect((await slot(id))?.workspace.reportMeta).toEqual({ remarks: 'from A', summary: 'from B' })
})

it('hole 1: «Hier bearbeiten» keeps what the holder saved, and the holder never writes after it', async () => {
  const id = `steal-${n}`
  const a = await tab(id)
  const b = await tab(id)
  edit(a, { reportMeta: { remarks: 'saved in A' } })
  await settle()
  edit(a, { reportMeta: { remarks: 'saved in A', lehren: 'typed in A, not yet on disk' } })
  b.takeOver()
  await vi.waitFor(() => expect(b.editing).toBe(true))
  await vi.waitFor(() => expect(a.editing).toBe(false))
  expect((engine(b).workspace as Saved).reportMeta?.remarks).toBe('saved in A')
  edit(b, { reportMeta: { summary: 'from B' } })
  await vi.advanceTimersByTimeAsync(10_000) // A's debounce, retry and every timer it had
  expect((await slot(id))?.workspace.reportMeta).toMatchObject({ remarks: 'saved in A', summary: 'from B' })
  expect(engine(a).canWrite).toBe(false)
})

it('hole 2: a tab opening behind the holder writes nothing over the holder’s newer draft', async () => {
  const id = `follower-${n}`
  const a = await tab(id)
  let answer!: () => void
  get.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ workspace: baseline, workspace_rev: 1 }) }))
  const b = new IncidentSelection()
  tabs.push(b)
  const opening = b.open(id, { id } as IncidentMeta, {})
  await vi.waitFor(() => expect(answer).toBeTypeOf('function')) // B read the slot, asked the server
  edit(a, { reportMeta: { remarks: 'newer in A' } })
  await settle()
  answer()
  await opening
  await settle()
  expect(await slot(id)).toMatchObject({ dirty: true, workspace: { reportMeta: { remarks: 'newer in A' } } })
  expect(b.editing).toBe(false)
})

it('hole 3: a holder that loses the lock mid-merge pushes nothing more', async () => {
  const id = `merge-${n}`
  const a = await tab(id)
  const b = await tab(id)
  const first = engine(a)
  put.mockRejectedValueOnce(new ApiError(409, 'conflict'))
  let answer!: () => void
  get.mockImplementationOnce(() => new Promise((resolve) => {
    answer = () => resolve({ workspace: { ...baseline, reportMeta: { summary: 'elsewhere' } }, workspace_rev: 2 })
  }))
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100) // the debounced PUT goes, is answered 409, the merge asks the server
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
  b.takeOver()
  await vi.waitFor(() => expect(b.editing).toBe(true))
  const putsBefore = put.mock.calls.filter((c) => c[4] === first.writerId).length
  answer()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(put.mock.calls.filter((c) => c[4] === first.writerId).length).toBe(putsBefore)
})

/** A server whose FIRST PUT is slow: it lands only when the test says so. */
function slowFirstPut() {
  const server = { rev: 1, workspace: baseline as Saved, reachable: true }
  get.mockImplementation(async () => {
    if (!server.reachable) throw offline
    return { workspace: server.workspace, workspace_rev: server.rev }
  })
  let landFirst: (() => void) | null = null
  put.mockImplementation((_id, ws, baseRev) => {
    const land = () => {
      if (baseRev !== server.rev) throw new ApiError(409, 'conflict')
      server.rev++
      server.workspace = ws as Saved
      return { workspace: null, workspace_rev: server.rev }
    }
    if (!landFirst) return new Promise((resolve, reject) => { landFirst = () => { try { resolve(land()) } catch (e) { reject(e) } } })
    if (!server.reachable) return Promise.reject(offline)
    return Promise.resolve().then(land)
  })
  return { server, land: () => landFirst?.() }
}
const marker = { id: 'x', type: 'symbol', lngLat: [7.5, 47.5] }

it.each([
  ['the new holder deletes it', false, false],
  ['the new holder deletes it, opened offline', true, false],
  ['the old holder had deleted it already', false, true],
])('a PUT the old holder still had on its way does not bring back a marker – %s', async (_case, offlineOpen, deletedInA) => {
  const id = `inflight-${n}`
  const net = slowFirstPut()
  const a = await tab(id)
  const b = await tab(id)
  edit(a, { entities: [marker] as unknown as Saved['entities'] })
  await vi.advanceTimersByTimeAsync(1_100) // A's PUT with the marker is on its way…
  await vi.waitFor(() => expect(put).toHaveBeenCalled()) // …once its record committed
  if (deletedInA) { edit(a, { entities: [] }); await settle() }
  if (offlineOpen) net.server.reachable = false
  b.takeOver()
  await vi.waitFor(() => expect(b.editing).toBe(true))
  if (!deletedInA) {
    expect(engine(b).workspace.entities).toEqual([marker])
    edit(b, { entities: [] })
  }
  net.server.reachable = true
  net.land() // A's PUT lands now, with the marker
  await engine(b).flush()
  await vi.advanceTimersByTimeAsync(70_000) // B pushes, 409, merges, pushes again
  expect(net.server.workspace.entities).toEqual([])
  expect((await slot(id))?.workspace.entities).toEqual([])
})

/** A server that holds every PUT until the test lands it: `land(i)` answers the i-th PUT. */
function heldPuts() {
  const server = { rev: 1, workspace: baseline as Saved }
  get.mockImplementation(async () => ({ workspace: server.workspace, workspace_rev: server.rev }))
  const waiting: (() => void)[] = []
  put.mockImplementation((_id, ws, baseRev) => new Promise((resolve, reject) => {
    waiting.push(() => {
      if (baseRev !== server.rev) { reject(new ApiError(409, 'conflict')); return }
      server.rev++
      server.workspace = ws as Saved
      resolve({ workspace: null, workspace_rev: server.rev })
    })
  }))
  return { server, puts: () => waiting.length, land: (i: number) => waiting[i]() }
}

// Sol r1 (27.11.2026): two hand-overs while both saves are on their way – the second engine's
// `sending` must not push out what the first handed it: A's PUT can still be the one that lands.
it('a steal back while both PUTs are on their way does not bring back what B deleted', async () => {
  const id = `two-puts-${n}`
  const net = heldPuts()
  const a = await tab(id)
  const b = await tab(id)
  edit(a, { entities: [marker] as unknown as Saved['entities'] })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(net.puts()).toBe(1)) // A's PUT with the marker is on its way
  b.takeOver()
  await vi.waitFor(() => expect(b.editing).toBe(true))
  edit(b, { entities: [] })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(net.puts()).toBe(2)) // B's PUT without it is on its way too
  a.takeOver()
  await vi.waitFor(() => expect(a.editing).toBe(true))
  expect(engine(a).workspace.entities).toEqual([])
  net.land(0) // A's old PUT wins: the marker is on the server
  net.land(1) // B's 409s, and B has retired
  edit(a, { reportMeta: { remarks: 'A again' } })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(net.puts()).toBe(3))
  net.land(2) // 409: the server holds A's old PUT – A merges
  await vi.waitFor(() => expect(net.puts()).toBe(4))
  net.land(3)
  await vi.waitFor(() => expect(engine(a).hasUnsynced).toBe(false))
  expect(net.server.workspace.entities).toEqual([])
  expect(net.server.workspace.reportMeta).toEqual({ remarks: 'A again' })
})

/** Hold every main-slot write that records a save on its way (CacheEntry.sending) until released. */
function holdSendingRecord() {
  const real = idb.idbSetFenced
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(idb, 'idbSetFenced').mockImplementation(async (key, value, fence, refused) => {
    if ((value as { sending?: unknown }).sending) await held
    return real(key, value, fence, refused)
  })
  return () => release()
}

// Sol r1 (27.11.2026): a PUT that left before its record committed is a PUT the next holder
// cannot know of – landing late, it would bring back what that holder deleted since.
it('a PUT leaves only once the cache has recorded it on its way', async () => {
  const id = `record-${n}`
  put.mockResolvedValue({ workspace: null, workspace_rev: 2 })
  const a = await tab(id)
  const release = holdSendingRecord()
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100) // the push debounce is over: the record is being written
  expect(put).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
})

it('a takeover while the record is still being written: the old holder’s PUT never leaves', async () => {
  const id = `record-steal-${n}`
  const a = await tab(id)
  const b = await tab(id)
  const holder = engine(a).writerId
  const release = holdSendingRecord()
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100)
  b.takeOver() // A retires at once; its record lands (or is refused) after that
  release()
  await vi.waitFor(() => expect(b.editing).toBe(true))
  await vi.advanceTimersByTimeAsync(70_000)
  expect(put.mock.calls.filter((c) => c[4] === holder)).toEqual([])
})

/** A server whose first PUT lands but whose answer is lost on the way back (a timeout).
 *  `hangRetry`: the next PUT never answers. */
function lostFirstAnswer(hangRetry: boolean, linkDrops = false) {
  const server = { rev: 1, workspace: baseline as Saved }
  get.mockImplementation(async () => ({ workspace: server.workspace, workspace_rev: server.rev }))
  put.mockImplementation(async (_id, ws, baseRev) => {
    if (put.mock.calls.length === 2 && hangRetry) return new Promise(() => {})
    if (baseRev !== server.rev) throw new ApiError(409, 'conflict')
    server.rev++
    server.workspace = ws as Saved
    // `linkDrops`: the browser goes offline before the lost answer is noticed
    if (server.rev === 2 && linkDrops) Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })
    if (server.rev === 2) throw new ApiError(0, 'timeout')
    return { workspace: null, workspace_rev: server.rev }
  })
  return server
}

// Sol r3 (27.11.2026): a PUT that landed but whose answer was lost is a save of unknown outcome.
// The retry's record must not erase it: if it did land, the marker deleted since is not a server
// addition – not in this engine's merge, and not in the next holder's.
it.each([
  ['in the same tab', false, false],
  ['after a takeover while the retry is on its way', true, false],
  ['in the same tab, the link dropping after the PUT left', false, true],
])('a PUT that landed without an answer brings back nothing deleted since – %s', async (_case, takeover, linkDrops) => {
  const id = `lost-${n}`
  const server = lostFirstAnswer(takeover, linkDrops)
  const a = await tab(id)
  const b = takeover ? await tab(id) : null
  edit(a, { entities: [marker] as unknown as Saved['entities'] })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(server.rev).toBe(2)) // landed – A heard nothing
  Reflect.deleteProperty(globalThis.navigator, 'onLine') // back online
  edit(a, { entities: [] })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(put.mock.calls.length).toBeGreaterThanOrEqual(2)) // A's retry, at the old revision
  if (b) {
    b.takeOver()
    await vi.waitFor(() => expect(b.editing).toBe(true))
    edit(b, { reportMeta: { remarks: 'from B' } })
  }
  const t = engine(b ?? a)
  await vi.waitFor(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
    expect(t.hasUnsynced).toBe(false)
  }, { timeout: 4_000 })
  expect(server.workspace.entities).toEqual([])
})

// Sol r4 (27.11.2026): a 409 is a definitive «no» – that PUT can never land, and carrying it into
// the next merge would hide a real divergence from the merge's conflict notes.
it('a PUT refused with 409 is not carried when the merge’s own fetch then gets no answer', async () => {
  const id = `refused-${n}`
  put.mockRejectedValue(new ApiError(409, 'conflict'))
  const a = await tab(id)
  get.mockRejectedValue(new ApiError(0, 'timeout')) // the merge asks the server: no answer
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2)) // the open's and the merge's
  await settle()
  expect(await slot(id)).toMatchObject({ dirty: true })
  expect((await idbGet<{ handed?: unknown }>(`kp-front-ws-${id}`))?.handed).toBeUndefined()
})

// Sol r5 (27.11.2026): …and the slot says so while the merge's fetch still hangs – a takeover in
// that window must not carry the refused PUT.
it('a PUT refused with 409 leaves the slot before the merge asks the server', async () => {
  const id = `refused-slot-${n}`
  put.mockRejectedValue(new ApiError(409, 'conflict'))
  const a = await tab(id)
  get.mockImplementation(() => new Promise(() => {})) // the merge's fetch hangs
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect((await idbGet<{ sending?: unknown }>(`kp-front-ws-${id}`))?.sending).toBeUndefined()
})

// Sol r5 (27.11.2026): an attempt made while the browser is offline never left. Its record goes,
// or the next holder would carry it and a real divergence would lose its conflict note.
it('an attempt made offline leaves no record of a PUT on its way', async () => {
  const id = `offline-attempt-${n}`
  const a = await tab(id)
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })
  edit(a, { reportMeta: { remarks: 'from A' } })
  await vi.advanceTimersByTimeAsync(1_100)
  await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
  await settle()
  await vi.waitFor(async () => {
    const stored = await idbGet<{ dirty: boolean; sending?: unknown; handed?: unknown }>(`kp-front-ws-${id}`)
    expect([stored?.dirty, stored?.sending, stored?.handed]).toEqual([true, undefined, undefined])
  })
})

it('a promotion overtaken by a steal back does not fence the thief out of its slot', async () => {
  const id = `claim-${n}`
  const a = await tab(id)
  const b = await tab(id)
  // B's claim is slow to reach IndexedDB; A steals editing back meanwhile
  const realSet = idb.idbSet
  let release!: () => void
  const slow = new Promise<void>((resolve) => { release = resolve })
  let claims = 0
  vi.spyOn(idb, 'idbSet').mockImplementation(async (key, value) => {
    if (key.endsWith('::__writer__') && ++claims === 1) await slow // B's claim, the first after the spy
    return realSet(key, value)
  })
  b.takeOver()
  await vi.advanceTimersByTimeAsync(0)
  a.takeOver()
  await vi.advanceTimersByTimeAsync(0)
  release()
  await vi.waitFor(() => expect(a.editing).toBe(true))
  edit(a, { reportMeta: { remarks: 'A again' } })
  await settle()
  expect((await slot(id))?.workspace.reportMeta).toEqual({ remarks: 'A again' })
})

it('an engine whose tab lost the edit lock before its claim’s turn claims nothing', async () => {
  const id = `late-grant-${n}`
  const a = await tab(id)
  const holder = engine(a).writerId
  // a grant that ran late: another tab already stole the lock back when this claim's turn came
  const { WorkspaceSync } = await import('./api/workspaceSync')
  const late = new WorkspaceSync(id, { lock: 'editor', holdsLock: () => false })
  await late.init()
  expect(await idbGet(`kp-front-ws-${id}::__writer__`)).toBe(holder)
  late.dispose()
})
