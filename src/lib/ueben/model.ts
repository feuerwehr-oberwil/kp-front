// «Üben»: the drill model. A drill is a concrete problem on the practice site (lib/ueben/site)
// with GOALS that the card ticks live; each goal is a pure check over a snapshot of the practice
// workspace and answers ok, still open (with an optional quiet note) or wrong WITH the reason
// (owner pick 3B, 19.11.2026: «a wrong value turns red with the reason»).
//
// «Zeigen» is a three-step ladder (owner picks, round 2026-11-19-ueben-zeigen): 1 the screen dims
// and a ring pulses on the ONE next control – or on the spot on the map – with the path in words;
// 2 a ghost hand plays the gesture on the real map; 3 «Lösung» does it. The next control is
// derived from the state every render (`Drill.hint`), so following the ring walks the path.
// «Lösung» writes through the workspace's own writers (`SolveApi`), so it is undoable like a hand.

import type { Doc } from '../workspace'
import type { WorkspaceMode } from '../../workspace/types'
import type { Drawing, Entity, LineAttachment, LngLat, MapTool } from '../../types'
import type { Site } from './site'

export type ModuleId = 'karteWasser' | 'atemschutzGebaeude' | 'protokollAbschluss'
export type DrillId =
  | 'fahrzeugLeitung' | 'absperrkreis' | 'messen' | 'leitungRechnen' | 'pumpenVerschieben'
  | 'truppAnmelden' | 'funkkontakt' | 'rueckzug' | 'notfall' | 'truppGeschoss' | 'gefahrUg'
  | 'eintrag' | 'pendenz' | 'checkliste' | 'anwesenheit' | 'material' | 'fehlalarm'

/** What the goals read. `answer` is the card's answer field (a drill with `answer`, e.g.
 *  «Messen»: the distance the operator read off), absent while empty. */
export interface Snapshot {
  entities: readonly Entity[]
  drawings: readonly Drawing[]
  answer?: string
}

export type GoalState = { s: 'ok' } | { s: 'open'; note?: string } | { s: 'wrong'; reason: string }

export interface Goal {
  /** key into the drill's `copy.ueben.drills.<id>.goals` */
  id: string
  check: (snap: Snapshot, site: Site) => GoalState
}

/** The UI the hint reads to know where the operator stands on the path. */
export interface UiState {
  phone: boolean
  mode: WorkspaceMode
  paletteOpen: boolean
  tool: MapTool
  pending: string | null
  selectedId: string | null
}

/** Where the ring goes: a control (CSS selector, the first VISIBLE match) or a spot on the map. */
export type Anchor = { kind: 'control'; sel: string } | { kind: 'map'; at: LngLat }
export type Gesture = { kind: 'tap'; at: LngLat } | { kind: 'drag'; from: LngLat; to: LngLat }
export interface Hint {
  anchor: Anchor
  /** the path in words beside the ring */
  words: string
  /** what the ghost hand plays (step 2); absent = step 2 shows the ring again */
  gesture?: Gesture
}

/** The workspace writers «Lösung» goes through – the same ones a hand uses (undo, Verlauf row). */
export interface SolveApi {
  addEntity: (e: Entity) => void
  patchEntity: (id: string, patch: Partial<Entity>) => void
  addLine: (coords: LngLat[], attachments?: { startAttachment?: LineAttachment; endAttachment?: LineAttachment }) => void
}

export interface Drill {
  id: DrillId
  module: ModuleId
  goals: readonly Goal[]
  /** the points the map frames when the drill starts and when «Zeigen» pans */
  focus: (site: Site) => LngLat[]
  /** the next step towards goal `goal` (the first one not ok) */
  hint: (snap: Snapshot, ui: UiState, site: Site, goal: number) => Hint | null
  solve: (snap: Snapshot, site: Site, api: SolveApi) => void
  /** clears what an earlier run of this drill left, so a second run starts from the problem.
   *  One commit – the operator's ↶ brings it back. */
  prepare?: (doc: Doc) => Doc
  /** the card's answer field */
  answer?: { unit: string }
}

/** Every goal's state, in order. */
export function goalStates(drill: Drill, snap: Snapshot, site: Site): GoalState[] {
  return drill.goals.map((g) => g.check(snap, site))
}

/** The first goal not yet ok, or -1 when the drill is done. */
export function nextGoal(states: readonly GoalState[]): number {
  return states.findIndex((s) => s.s !== 'ok')
}
