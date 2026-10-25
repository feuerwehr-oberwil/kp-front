import { useRef, useState } from 'react'
import type { LineAttachment } from '../types'
import { buzz } from './haptics'
import {
  advanceDwell, armDwell, distance, dwellFor, EMPTY_DWELL, nearestMagneticTarget, stickyMagneticTarget,
  STROKE_START_RADIUS_PX, type DwellState, type MagneticTarget, type Point,
} from './lineAttachments'

/** What a draft's two ends have docked onto so far. */
export interface DraftAttachments { startAttachment?: LineAttachment; endAttachment?: LineAttachment }

/** One stroke's magnet, in the surface's stored coordinates `P` (the Karte's LngLat, the Plan's
 *  BoardPoint). Rendered by the surface: the ConnectRing on `candidate`, the «Angekuppelt» rings
 *  from `joinTargets`. */
export interface DraftMagnet<P> extends DraftAttachments {
  /** where the stroke went DOWN — the start keeps its claim within STROKE_START_RADIUS_PX of it */
  first: P
  point: P
  /** does an armed target here belong to the stroke's START (true) or its far end? */
  atStart: boolean
  dwell: DwellState
  candidate: MagneticTarget | null
  /** the line target the stroke's START is coupled onto, held for the whole stroke so the
   *  «Angekuppelt» ring stays on it after the finger has left */
  startJoin?: MagneticTarget
}

/** The surface half: its px projection, its target walk (`'__draft__'` as the source) and what a
 *  candidate becomes as an attachment. Read fresh on every call. */
export interface DraftMagnetSurface<P> {
  project: (p: P) => Point
  candidates: (at: P) => MagneticTarget[]
  attachmentFor: (candidate: MagneticTarget) => LineAttachment
}

/**
 * «Ring lädt, dann schnappt es» for a line being DRAWN — the one machine under both surfaces
 * (MapView · updateDraftMagnet, usePlanDraft · updatePlanDraftMagnet), which used to be two copies
 * kept in step by review. The rules (docs/ui-conventions.md · Touch vocabulary):
 *
 * - **Line-START exception** (`start`). A pointerDOWN that already lands inside a target's radius
 *   is deliberate aim: the finger was PUT on the Teilstück's prong because that is where the
 *   branch begins. It arms at once and its ring is drawn full — the dwell exists to catch SYMBOLS a
 *   moving line PASSES OVER, not the one it was aimed at (a line target never dwells at all —
 *   lib/lineAttachments · dwellFor). Node-mode taps come through here too, for the same reason.
 *   The attachment is banked right away, on the end `atStart` names.
 * - **The start's claim** (`move`). While the finger is still within STROKE_START_RADIUS_PX of the
 *   pointerDOWN point and no start attachment is banked, a target acquired belongs to the START.
 *   Leaving that radius ends the claim for good: from there the FAR end earns its own ring, even
 *   over the very target the stroke began on — without the reset the instantly armed start would
 *   hand its `armed` straight to the end. (The Plan once handed `false` in from the first pixel,
 *   so a SHORT stroke begun on a symbol lost the start's ring — useDraftMagnet.test.)
 * - **Dwell** (`move` + timer). A symbol acquired later has to hold still for MAGNET_DWELL_MS; a
 *   finger that has found its target STOPS MOVING, so no pointermove fires and the timer is what
 *   actually closes the ring. One buzz when it does.
 * - **Release** (`end`). Only a CLOSED ring attaches: a stroke that FINISHES on a symbol without
 *   pausing there lands free — deliberately, and it is the reason the ring is drawn at all. (Until
 *   25.08. both surfaces recomputed the target at release and attached regardless, which is the
 *   invisible coupling from the field.) Returns both ends' attachments; undefined when no stroke
 *   was in progress.
 */
export function useDraftMagnet<P>(surface: DraftMagnetSurface<P>) {
  const [state, setState] = useState<DraftMagnet<P> | null>(null)
  const ref = useRef<DraftMagnet<P> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const set = (next: DraftMagnet<P> | null) => { ref.current = next; setState(next) }

  /** pointerDOWN — returns the attachment banked on the spot, if the press landed on a target */
  const start = (point: P, atStart: boolean): DraftAttachments => {
    if (timer.current) clearTimeout(timer.current)
    const candidate = nearestMagneticTarget(surface.project(point), surface.candidates(point))
    const attachment = candidate ? surface.attachmentFor(candidate) : undefined
    const banked: DraftAttachments = attachment ? (atStart ? { startAttachment: attachment } : { endAttachment: attachment }) : {}
    const startJoin = atStart && candidate?.target.kind === 'line' ? candidate : undefined
    set({ first: point, point, atStart, candidate, dwell: armDwell(candidate?.key ?? null, Date.now()), ...banked, ...(startJoin ? { startJoin } : {}) })
    if (candidate) buzz()
    return banked
  }

  const move = (point: P) => {
    if (timer.current) clearTimeout(timer.current)
    const cur = ref.current
    if (!cur) return
    const pointer = surface.project(point)
    const atStart = cur.atStart && distance(surface.project(cur.first), pointer) < STROKE_START_RADIUS_PX && !cur.startAttachment
    const candidate = stickyMagneticTarget(pointer, surface.candidates(point), cur.candidate?.key ?? null)
    const base = atStart === cur.atStart ? cur.dwell : EMPTY_DWELL
    const next: DraftMagnet<P> = { ...cur, point, atStart, candidate, dwell: advanceDwell(base, candidate, Date.now()) }
    set(next)
    // a line target arms on acquisition (dwellFor = 0) — one buzz, as the closed ring gives
    if (next.dwell.armed && !base.armed) buzz()
    // arm on a motionless finger (no pointermove ⇒ no advanceDwell); the attachment itself is
    // only written on release, so moving on after arming still lets the end go free
    if (candidate && !next.dwell.armed) timer.current = setTimeout(() => {
      const now = ref.current
      if (!now || now.candidate?.key !== candidate.key) return
      set({ ...now, dwell: { ...now.dwell, armed: true } })
      buzz()
    }, Math.max(0, dwellFor(candidate) - (Date.now() - next.dwell.since)))
  }

  const end = (): DraftAttachments | undefined => {
    if (timer.current) clearTimeout(timer.current)
    const cur = ref.current
    set(null)
    if (!cur) return undefined
    let { startAttachment, endAttachment } = cur
    if (cur.dwell.armed && cur.candidate) {
      const attachment = surface.attachmentFor(cur.candidate)
      if (cur.atStart) startAttachment = startAttachment ?? attachment
      else endAttachment = endAttachment ?? attachment
    }
    return { startAttachment, endAttachment }
  }

  return { state, current: () => ref.current, start, move, end }
}

/** The joints a gesture in progress is coupled onto — the «Angekuppelt» rings: the draft's start
 *  for the whole stroke, plus an ARMED line target under a draft end or a dragged end. Each
 *  surface rings them at its own coordinates, in the TARGET line's ink. */
export function joinTargets(
  draft: Pick<DraftMagnet<unknown>, 'startJoin' | 'dwell' | 'candidate'> | null,
  drag: { dwell: DwellState; candidate: MagneticTarget | null } | null,
): MagneticTarget[] {
  const out: MagneticTarget[] = draft?.startJoin ? [draft.startJoin] : []
  for (const g of [draft, drag]) {
    const c = g?.candidate
    if (!g?.dwell.armed || c?.target.kind !== 'line' || out.some((j) => j.key === c.key)) continue
    out.push(c)
  }
  return out
}
