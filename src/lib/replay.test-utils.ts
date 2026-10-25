import { stateAt } from './replay'
import type { ReplayEvent } from './replay'
import type { Saved } from './workspace'
import type { Drawing, Entity } from '../types'

/**
 * What the replay shows after a surface's `emit` calls: the calls go through JSON (as on the
 * wire – an `undefined` key is dropped) and are folded by the real `stateAt` over a snapshot of
 * `before`. Hand it a hook test's `emit` mock's `.mock.calls`.
 */
export async function replayEmits(
  before: { entities?: Entity[]; drawings?: Drawing[] },
  calls: readonly (readonly unknown[])[],
): Promise<{ entities: Entity[]; drawings: Drawing[] }> {
  const events: ReplayEvent[] = calls.map(([op_type, payload], i) => ({
    seq: i + 1,
    occurred_at: new Date(1000 + i).toISOString(),
    op_type: String(op_type),
    payload_json: JSON.parse(JSON.stringify(payload ?? {})),
  }))
  const workspace: Saved = { entities: before.entities ?? [], drawings: before.drawings ?? [], recent: [], layerState: [], timeline: [] }
  const state = await stateAt({
    incidentId: 'inc1', events, samples: [], startMs: 0, endMs: 10_000, snapshotCache: new Map(),
    loadSnapshotAt: async () => ({ workspace, occurredMs: 0 }),
  }, 10_000)
  if (!state) throw new Error('replay folded to nothing')
  return { entities: state.entities, drawings: state.drawings }
}
