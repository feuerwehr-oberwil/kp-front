import { afterEach, expect, it, vi } from 'vitest'
import { archiveIncident, getIncident, type IncidentMeta } from './api/incidents'
import { WorkspaceSync, type WorkspaceSyncOptions } from './api/workspaceSync'
import * as syncModule from './api/workspaceSync'
import type { Workspace } from './api/workspace'
import { clearIncidentMedia } from './mediaQueue'
import { IncidentSelection, undoTakenIncident } from './incidentSelection'

vi.mock('./api/incidents', () => ({ archiveIncident: vi.fn(), getIncident: vi.fn() }))

vi.mock('./mediaQueue', () => ({ clearIncidentMedia: vi.fn(async () => {}) }))

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['metadata', 'workspace'])('keeps the active incident live after a failed %s read', async (failure) => {
  const original = new WorkspaceSync('a')
  const active = new IncidentSelection()
  active.current = original
  const retire = vi.spyOn(original, 'dispose')
  const unavailable = new Error('offline')
  vi.mocked(getIncident).mockRejectedValue(unavailable)
  vi.spyOn(WorkspaceSync.prototype, 'init').mockRejectedValue(unavailable)
  const meta = failure === 'metadata' ? undefined : { id: 'b' } as IncidentMeta
  await expect(active.open('b', meta, {})).rejects.toBe(unavailable)
  expect(active.current).toBe(original)
  expect(retire).not.toHaveBeenCalled()
})

it('keeps a superseding selection when the earlier request resolves last', async () => {
  const active = new IncidentSelection()
  let finish!: () => void
  vi.spyOn(WorkspaceSync.prototype, 'init').mockImplementation(async function (this: WorkspaceSync) {
    if (this.incidentId === 'b') await new Promise<void>((resolve) => { finish = resolve })
    return { workspace: {}, rev: 1, fromCache: false }
  })
  const first = active.open('b', { id: 'b' } as IncidentMeta, {})
  await active.open('c', { id: 'c' } as IncidentMeta, {})
  finish()
  expect(await first).toBeNull()
  expect(active.current?.incidentId).toBe('c')
})

it('coalesces two pending opens of B and never disposes the winning engine', async () => {
  const active = new IncidentSelection()
  let finish!: () => void
  const init = vi.spyOn(WorkspaceSync.prototype, 'init').mockImplementation(async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    return { workspace: {}, rev: 1, fromCache: false }
  })
  const dispose = vi.spyOn(WorkspaceSync.prototype, 'dispose')
  const first = active.open('b', { id: 'b' } as IncidentMeta, {})
  const second = active.open('b', { id: 'b' } as IncidentMeta, {})
  finish()
  expect(await first).toBeNull()
  expect(await second).toMatchObject({ meta: { id: 'b' } })
  expect(init).toHaveBeenCalledOnce()
  expect(dispose).not.toHaveBeenCalled()
})

it('unmount during a cold boot disposes the candidate and never adopts it', async () => {
  const active = new IncidentSelection()
  let finish!: () => void
  vi.spyOn(WorkspaceSync.prototype, 'init').mockImplementation(async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    return { workspace: {}, rev: 1, fromCache: false }
  })
  const retire = vi.spyOn(WorkspaceSync.prototype, 'dispose')
  const boot = active.open('b', { id: 'b' } as IncidentMeta, {})
  active.dispose()
  finish()
  expect(await boot).toBeNull()
  expect(active.current).toBeNull()
  expect(retire).toHaveBeenCalledOnce()
})

it('keeps the live incident and pending media when undoing the take fails', async () => {
  const original = new WorkspaceSync('take')
  const active = new IncidentSelection()
  active.current = original
  vi.mocked(archiveIncident).mockRejectedValueOnce(new Error('offline'))
  await expect(undoTakenIncident(active, 'take', () => true, vi.fn())).rejects.toThrow('offline')
  expect(active.current).toBe(original)
  expect(clearIncidentMedia).not.toHaveBeenCalled()
})

it('an acknowledged undo clears only the taken incident if the operator has moved on', async () => {
  const original = new WorkspaceSync('take')
  const active = new IncidentSelection()
  active.current = original
  const other = new WorkspaceSync('other')
  vi.mocked(archiveIncident).mockImplementationOnce(async () => {
    active.current = other
    return { id: 'take' } as Awaited<ReturnType<typeof archiveIncident>>
  })
  await expect(undoTakenIncident(active, 'take', () => true, async () => [])).resolves.toBeNull()
  expect(active.current).toBe(other)
  expect(clearIncidentMedia).toHaveBeenCalledWith('take')
})

it('retires the old engine only after the new one loads and its own last save finishes', async () => {
  const original = new WorkspaceSync('a')
  const active = new IncidentSelection()
  active.current = original
  const retire = vi.spyOn(original, 'dispose')
  vi.spyOn(WorkspaceSync.prototype, 'init').mockResolvedValue({ workspace: {}, rev: 1, fromCache: false })
  const flush = vi.spyOn(original, 'flush').mockImplementation(async () => {
    expect(active.current).toBe(original)
    expect(retire).not.toHaveBeenCalled()
  })
  expect(await active.open('b', { id: 'b' } as IncidentMeta, {})).toMatchObject({ meta: { id: 'b' } })
  expect(flush).toHaveBeenCalledOnce()
  expect(retire).toHaveBeenCalledOnce()
  expect(active.current?.incidentId).toBe('b')
})

// Deliver the same notices as a late recovery probe while the previous incident finishes saving.
// Keep the candidate's live snapshot separate from the one its init() promise returned.
function pendingRecovery() {
  const active = new IncidentSelection()
  const previous = new WorkspaceSync('a')
  active.current = previous
  let finish!: () => void
  const flushing = new Promise<void>((resolve) => { finish = resolve })
  const flush = vi.spyOn(previous, 'flush').mockReturnValue(flushing)
  let notify!: (revision: number) => void
  class RecoveringEngine extends WorkspaceSync {
    private snapshot = { workspace: { recovered: 0 }, rev: 1, fromCache: false }
    constructor(id: string, options: WorkspaceSyncOptions = {}) {
      super(id, options)
      notify = (revision) => {
        this.snapshot = { workspace: { recovered: revision }, rev: revision, fromCache: false }
        options.onRev?.(revision)
        options.onServerWorkspace?.(this.workspace, revision)
        options.onMerged?.()
      }
    }
    override async init() { return this.snapshot }
    override get workspace(): Workspace { return this.snapshot.workspace }
    override get rev() { return this.snapshot.rev }
  }
  vi.spyOn(syncModule, 'WorkspaceSync').mockImplementation(function (id, options) { return new RecoveringEngine(id, options) })
  const options = { onServerWorkspace: vi.fn(), onRev: vi.fn(), onMerged: vi.fn() }
  const opening = active.open('b', { id: 'b' } as IncidentMeta, options)
  return { active, opening, flush, finish, notify, options }
}

it('forwards candidate view callbacks only while its engine is current', async () => {
  const { active, opening, flush, finish, notify, options } = pendingRecovery()
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
  notify(2)
  for (const callback of Object.values(options)) expect(callback).not.toHaveBeenCalled()
  finish()
  await opening
  notify(3)
  expect(options.onServerWorkspace).toHaveBeenCalledWith({ recovered: 3 }, 3)
  active.dispose()
  notify(4)
  for (const callback of Object.values(options)) expect(callback).toHaveBeenCalledOnce()
})

it('ignores a discarded candidate when the operator returns to the current incident', async () => {
  const { active, opening, flush, finish, notify, options } = pendingRecovery()
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
  await active.open('a', { id: 'a' } as IncidentMeta, {})
  notify(2)
  finish()
  expect(await opening).toBeNull()
  expect(active.current?.incidentId).toBe('a')
  for (const callback of Object.values(options)) expect(callback).not.toHaveBeenCalled()
})

it('keeps the null initial blob of a new incident when nothing arrived during the switch', async () => {
  const active = new IncidentSelection()
  vi.spyOn(WorkspaceSync.prototype, 'init').mockResolvedValueOnce({ workspace: null, rev: 0, fromCache: false })
  expect(await active.open('empty', { id: 'empty' } as IncidentMeta, {})).toMatchObject({ workspace: null, rev: 0 })
})

it('hydrates the latest candidate workspace and revision after the previous flush', async () => {
  const { opening, flush, finish, notify } = pendingRecovery()
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
  notify(2)
  finish()
  expect(await opening).toMatchObject({ workspace: { recovered: 2 }, rev: 2 })
})
