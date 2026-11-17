// The active Einsatz owns the live poll, alarm and edit queue. Only the selection that
// actually opens may take that engine away from the operator.
import { archiveIncident, getIncident, type IncidentMeta } from './api/incidents'
import { clearIncidentMedia } from './mediaQueue'
import { WorkspaceSync, type WorkspaceSyncOptions } from './api/workspaceSync'

export class IncidentSelection {
  current: WorkspaceSync | null = null
  generation = 0
  private pending: { engine: WorkspaceSync; loaded: ReturnType<WorkspaceSync['init']> } | null = null

  private cancelPending() {
    this.pending?.engine.dispose()
    this.pending = null
  }

  dispose() {
    this.generation++
    this.cancelPending()
    this.current?.dispose()
    this.current = null
  }

  async open(id: string, meta: IncidentMeta | undefined, options: WorkspaceSyncOptions) {
    const generation = ++this.generation
    const previous = this.current
    const stillOpening = () => generation === this.generation && this.current === previous
    if (this.pending?.engine.incidentId !== id) this.cancelPending()
    try {
      const incident = meta ?? await getIncident(id)
      if (!stillOpening()) return null
      if (previous?.incidentId === id) return { meta: incident, workspace: previous.workspace, rev: previous.rev }

      // A second tap on the same Einsatz joins its load. Two candidates for one id
      // would both write the same cache, including on teardown of the losing request.
      if (!this.pending) {
        const engine = new WorkspaceSync(id, options)
        this.pending = { engine, loaded: engine.init() }
      }
      const candidate = this.pending
      const opened = await candidate.loaded
      if (!stillOpening()) return null
      await previous?.flush()
      if (!stillOpening()) return null
      previous?.dispose()
      this.current = candidate.engine
      this.pending = null
      return { meta: incident, workspace: opened.workspace, rev: opened.rev }
    } catch (error) {
      if (stillOpening()) throw error
      return null
    } finally {
      if (generation === this.generation) this.cancelPending()
    }
  }
}

/** Undo a one-tap Divera take. Only the acknowledged archive can discard that take's media.
 * A switch made while the toast was visible or the request was in flight keeps its live engine. */
export async function undoTakenIncident(
  active: { current: WorkspaceSync | null }, id: string, isCurrent: () => boolean,
  refreshList: () => Promise<IncidentMeta[]>,
) {
  await archiveIncident(id)
  await clearIncidentMedia(id).catch(() => {})
  const list = await refreshList()
  if (!isCurrent() || active.current?.incidentId !== id) return null
  active.current.dispose()
  active.current = null
  return list
}
