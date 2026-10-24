import { minPoints } from './vertexOps'

/**
 * The draft contract both create surfaces run — the Karte (lib/useMapDrawing) and the Plan
 * (components/Whiteboard): what a tapped-out Punkte-Linie or Fläche turns into on ✓ «Fertig»,
 * and on the A6 tap-away (29.08.: picking another tool, a selection landing, leaving the surface).
 * Pure decisions over the armed tool, its mode and the draft's point count; each surface keeps
 * its own storage, commit funnel and toasts, and only asks here what to do, so the A6 rule cannot
 * fork again (docs/tactical-objects.md · Lage ↔ Plan parity).
 */
export type DraftKind = 'line' | 'area'
export type DraftMode = 'freehand' | 'nodes'

/** What a tap-away does to the draft in the hand. */
export type DraftRelease =
  /** nothing in the hand, or a draft that is not this tool's to touch */
  | { type: 'keep' }
  /** a Freihand remnant (a tool switch mid-stroke): it dies with its tool, silently */
  | { type: 'drop' }
  /** a fragment below the minimum, or a surface that may no longer write: dropped, and an
   *  action-less toast says so — never a silent loss */
  | { type: 'discard' }
  /** committed through the ✓'s own funnel, with the toast whose «Rückgängig» hands the shape back */
  | { type: 'commit'; kind: DraftKind }

/** The shape ✓ «Fertig» commits for the armed tool — a Linie from 2 points, a Fläche from 3
 *  (lib/vertexOps · minPoints) — or null when the draft is not one yet. */
export function finishKind(tool: string, count: number): DraftKind | null {
  const kind: DraftKind | null = tool === 'line' ? 'line' : tool === 'area' ? 'area' : null
  return kind && count >= minPoints(kind) ? kind : null
}

/** ✓ «Fertig» is enabled: a node-mode draft of the armed tool that would commit. */
export function draftActive(tool: string, modes: { lineMode: DraftMode; areaMode: DraftMode }, count: number): boolean {
  const mode = tool === 'line' ? modes.lineMode : tool === 'area' ? modes.areaMode : null
  return mode === 'nodes' && finishKind(tool, count) != null
}

/**
 * A6 — the tool being LEFT (`from`) decides, never the one being armed: the undo below restores a
 * draft WHILE re-arming its tool, and that arming must not read as a tap-away that eats the very
 * shape it just handed back. A committable draft auto-commits; `locked` (replay, lost tab lock,
 * Führungsansicht) makes every draft a discard, because the create funnel would refuse it.
 * Escape is NOT routed here — it is the one explicit discard.
 */
export function releaseDraft({ from, lineMode, count, locked = false }: { from: string; lineMode: DraftMode; count: number; locked?: boolean }): DraftRelease {
  if (!count) return { type: 'keep' }
  const kind: DraftKind | null = from === 'area' ? 'area' : from === 'line' && lineMode === 'nodes' ? 'line' : null
  if (!kind) return from === 'line' ? { type: 'drop' } : { type: 'keep' }
  if (locked || count < minPoints(kind)) return { type: 'discard' }
  return { type: 'commit', kind }
}
