// «Üben»: the model. A TOPIC («Karte & Zeichnen») is a chain of short STEPS on the practice site
// (lib/ueben/site); each step is one small task with GOALS the card ticks live. A goal is a pure
// check over a snapshot of the practice workspace and answers ok, still open or wrong WITH the
// reason (no how-to line under a goal – owner, round 2: «Zeigen» is where the how lives).
//
// Owner picks, 20.11.2026 (after «only scratching the top part of the surface»): topics with short
// steps, each building on the result of the one before; coverage = what an Einsatz needs.
//
// ⚠️ Goals are reached IN ORDER and stay reached for the run (components/ueben/UebenRunner). So a
// goal may be about a CHANGE – «Punkt eingefügt», then «Punkt entfernt» – and reads `since`: the
// Lage when its turn began (the step's start, or the moment the goal before it was reached).
//
// ⚠️ Checks are LENIENT (owner pick, 20.11.2026): a goal is ok when the function was used with a
// sensible result. An exact value is asked only where the number is the lesson (Messen, Leitung
// rechnen). `wrong` is for what would be wrong on a real Einsatz (an arrow against the water) or
// for a result so far off that the step cannot go on – never for a tolerance band.
//
// «Zeigen» is a three-step ladder (owner picks, round 2026-11-19-ueben-zeigen): 1 the screen dims
// and a ring pulses on the ONE next control – or on the spot on the map – with the path in words;
// 2 a ghost hand plays the gesture on the real map; 3 «Lösung» does it. The next control is
// derived from the state every render (`Step.hint`), so following the ring walks the path.
// «Lösung» reaches the CURRENT goal, as one commit of the workspace – ↶ takes it back.

import type { Doc } from '../workspace'
import type { WorkspaceMode } from '../../workspace/types'
import type { Drawing, Entity, LngLat, MapTool } from '../../types'
import type { Site } from './site'

/** What the goals read. */
export interface Snapshot {
  entities: readonly Entity[]
  drawings: readonly Drawing[]
}

export type GoalState = { s: 'ok' } | { s: 'open' } | { s: 'wrong'; reason: string }

export interface Goal {
  /** key into the step's `goals` copy */
  id: string
  check: (snap: Snapshot, site: Site, since: Snapshot) => GoalState
}

/** The UI the hint reads to know where the operator stands on the path. */
export interface UiState {
  phone: boolean
  mode: WorkspaceMode
  paletteOpen: boolean
  tool: MapTool
  pending: string | null
  selectedId: string | null
  selectedDrawingId: string | null
}

/** Where the ring goes: a control or a spot on the map.
 *  - `sel`: CSS selectors in order of preference – the first one with a VISIBLE match wins, so a
 *    menu's row can be named ahead of the button that opens the menu.
 *  - `hold`: the control is pressed and HELD (a point's pad until its ring is full).
 *  - `at`: the map points the control belongs to (a point's pad is a marker on the map) – kept in
 *    the free part of the map, never under a sheet. */
export type Anchor = { kind: 'control'; sel: readonly string[]; hold?: true; at?: readonly LngLat[] } | { kind: 'map'; at: LngLat }
/** `hold` on a drag: the hand stays at the end until the connect ring is full. */
export type Gesture = { kind: 'tap'; at: LngLat } | { kind: 'drag'; from: LngLat; to: LngLat; hold?: true }
export interface Hint {
  anchor: Anchor
  /** the path in words beside the ring */
  words: string
  /** what the ghost hand plays (step 2); absent = step 2 shows the ring again */
  gesture?: Gesture
}

/** One step of a topic. Its `id` is its key in the catalogue (lib/ueben/catalogue · StepId), in
 *  the done list of this device and in the topic's copy (`copy.ueben.topics.<topic>.steps.<id>`). */
export interface Step {
  id: string
  goals: readonly Goal[]
  /** the points the map keeps in view: the site's, and what the operator placed */
  focus: (site: Site, snap: Snapshot) => LngLat[]
  /** the next move towards goal `goal` (the first one not reached) */
  hint: (snap: Snapshot, ui: UiState, site: Site, goal: number, since: Snapshot) => Hint | null
  /** «Lösung»: the Lage with goal `goal` reached */
  solve: (doc: Doc, site: Site, goal: number, since: Snapshot) => Doc
  /** What the step starts from – applied on every fresh start (the sheet, «Weiter», «Nochmals»):
   *  it BUILDS what the steps before it leave (a step can be started on its own) and CLEARS what an
   *  earlier run of this step left. Unchanged when the Lage already is that start. */
  setup: (doc: Doc, site: Site) => Doc
}

export interface Topic {
  id: string
  steps: readonly Step[]
}

/** The control anchor of one selector – the common case. */
export const control = (...sel: string[]): Anchor => ({ kind: 'control', sel })
