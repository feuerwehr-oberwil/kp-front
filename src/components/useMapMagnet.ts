import { useMemo, useRef, useState, type RefObject } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LineAttachment, LineEndpoint, LngLat } from '../types'
import { buzz } from '../lib/haptics'
import { DEFAULT_INK } from '../lib/lineStyle'
import { joinTargets, useDraftMagnet, type DraftAttachments } from '../lib/useDraftMagnet'
import { DRAFT_SOURCE } from './mapMagnetTargets'
import { advanceDwell, candidateAttachment, detachProgress, dwellFor, EMPTY_DWELL, nextFreePort, stickyMagneticTarget, type AttachableLine, type DwellState, type MagneticTarget } from '../lib/lineAttachments'

/** A selected line's end in the hand. `origin` + `attached` + `detach` are the RELEASE half of the
 *  ring language: where the endpoint was plugged in when the drag started, whether it still is,
 *  and how full the red ring is. `carry`: the Trupp marker this end is coupled to – the grip then
 *  moves the MARKER, and the hose end follows it as it always does (15.09., «the Trupp belongs to
 *  the hose»). */
export type EndpointDrag = { id: string; endpoint: LineEndpoint; coord: LngLat; origin: LngLat; attached: boolean; detach: number; dwell: DwellState; candidate: MagneticTarget | null; carry?: string }

export interface MapMagnetDeps {
  mapInst: RefObject<MlMap | null>
  /** the drawings as stored (their coords are the fallbacks the resolver starts from) */
  storedDrawings: Drawing[]
  entities: Entity[]
  /** the surface's target walk (MapView · candidatesAt) — called at event time only */
  candidates: (sourceId: string, at: LngLat) => MagneticTarget[]
  /** the line being drawn: node taps or a freehand stroke (lib/useMapDrawing); `startAttachment` is
   *  what a node draft's first tap banked */
  draft: { kind: 'line' | 'area' | null; freehand: 'line' | 'area' | null; length: number; onPointAttachment?: (attachment?: LineAttachment) => void; startAttachment?: LineAttachment }
  onDrawingAttachment?: (id: string, endpoint: LineEndpoint, attachment: LineAttachment | undefined, fallback: LngLat) => void
  /** an end coupled to a Trupp marker moves the marker instead: its drag's three phases
   *  (MapView · teamJoinMarkerMove / teamJoinMarkerDragEnd) */
  carry: { start: (markerId: string) => void; move: (markerId: string, c: LngLat) => void; end: (markerId: string, c: LngLat) => void }
}

/**
 * The Lage's line-end magnets: a selected line's end being DRAGGED (attach / retarget / the
 * distance-driven release ring) and a line being DRAWN (the shared draft machine,
 * lib/useDraftMagnet). Also the source of `attachmentLines` — the stored lines with the dragged
 * end following the finger and treated as free, which every resolver in MapView reads. Rules:
 * docs/ui-conventions.md · Touch vocabulary («Ring lädt, dann schnappt es»).
 */
export function useMapMagnet({ mapInst, storedDrawings, entities, candidates, draft, onDrawingAttachment, carry }: MapMagnetDeps) {
  const [endpointDrag, setEndpointDragState] = useState<EndpointDrag | null>(null)
  const endpointDragRef = useRef<EndpointDrag | null>(null)
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setEndpointDrag = (next: EndpointDrag | null) => { endpointDragRef.current = next; setEndpointDragState(next) }

  // Resolve magnetic intent late, in the renderer's current screen space. Stored endpoint
  // coordinates stay untouched as fallbacks; every downstream map consumer sees this single
  // resolved list (ink, hit testing, arrows, labels, bounds and edit handles).
  // The dragged endpoint follows the FINGER, so its live coord goes into resolution and that
  // endpoint is temporarily free (its own attachment ignored) — attached branch lines then follow
  // the node live (move + carry) instead of snapping only on release. The other endpoint keeps
  // its attachment.
  // ⚠️ MEMOIZED (perf sweep 23.09.2026) — see the chain note in MapView (resolvedCoords).
  const attachmentLines = useMemo((): AttachableLine<LngLat>[] => storedDrawings
    .filter((d) => d.kind === 'line' && d.coords.length >= 2)
    .map((d) => {
      const drag = endpointDrag?.id === d.id ? endpointDrag : null
      if (!drag) return { id: d.id, points: d.coords, teilstueck: d.teilstueck, width: d.width, startAttachment: d.startAttachment, endAttachment: d.endAttachment }
      const idx = drag.endpoint === 'start' ? 0 : d.coords.length - 1
      return {
        id: d.id, points: d.coords.map((p, i) => (i === idx ? drag.coord : p)), teilstueck: d.teilstueck, width: d.width,
        startAttachment: drag.endpoint === 'start' ? undefined : d.startAttachment,
        endAttachment: drag.endpoint === 'end' ? undefined : d.endAttachment,
      }
    }), [storedDrawings, endpointDrag])

  // …a live GPS marker's end starts out guarded where the marker stands (lib/lineAttachments)
  const attachmentForCandidate = (candidate: MagneticTarget): LineAttachment =>
    candidateAttachment(candidate, attachmentLines, (id) => { const e = entities.find((x) => x.id === id); return e?.live ? e.coord : undefined })
  // the magnet of a line being DRAWN — the Plan's own machine (lib/useDraftMagnet), over this
  // surface's projection and target walk
  const draftMagnet = useDraftMagnet<LngLat>({
    project: (c) => { const p = mapInst.current!.project(c); return [p.x, p.y] },
    candidates: (c) => candidates(DRAFT_SOURCE, c),
    attachmentFor: (c) => attachmentForCandidate(c),
  })

  const beginEndpointDrag = (id: string, endpoint: LineEndpoint, coord: LngLat) => {
    const stored = storedDrawings.find((d) => d.id === id)
    const a = endpoint === 'start' ? stored?.startAttachment : stored?.endAttachment
    // An end coupled to a Trupp's marker is not pulled OFF the marker by dragging it (15.09.):
    // the grip takes the marker along – off the symbol it was docked to, onto the next one, or
    // just elsewhere – and the hose end rides with it. Parting the two is the editor's «Lösen».
    const marker = a?.target.kind === 'object' ? entities.find((e) => e.id === a.target.id) : undefined
    if (marker?.kind === 'team' && marker.truppId && stored?.truppId === marker.truppId && !marker.live) {
      carry.start(marker.id)
      setEndpointDrag({ id, endpoint, coord, origin: coord, attached: true, detach: 0, dwell: EMPTY_DWELL, candidate: null, carry: marker.id })
      return
    }
    setEndpointDrag({ id, endpoint, coord, origin: coord, attached: !!a, detach: 0, dwell: EMPTY_DWELL, candidate: null })
  }
  const moveEndpointDrag = (coord: LngLat) => {
    const st = endpointDragRef.current, map = mapInst.current
    if (!st || !map) return
    // the coupled marker moves, the end follows (see beginEndpointDrag)
    if (st.carry) { setEndpointDrag({ ...st, coord }); carry.move(st.carry, coord); return }
    const pointer = map.project(coord)
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    // Still hooked up? Then the only thing on offer is letting go, and the red ring at the OLD
    // socket runs on distance: pull past the detach radius and the link is off (the endpoint is
    // free from here on, and can court a new target below); stop short and release, and it
    // springs back exactly where it was. No candidate is offered meanwhile — a blue ring while
    // the line is still connected somewhere else would be two promises at once.
    if (st.attached) {
      const o = map.project(st.origin)
      const detach = detachProgress([o.x, o.y], [pointer.x, pointer.y])
      setEndpointDrag({ ...st, coord, detach, attached: detach < 1, candidate: null, dwell: EMPTY_DWELL })
      if (detach >= 1) buzz()
      return
    }
    const targets = candidates(st.id, coord)
    const candidate = stickyMagneticTarget([pointer.x, pointer.y], targets, st.candidate?.key ?? null)
    const dwell = advanceDwell(st.dwell, candidate, Date.now())
    setEndpointDrag({ ...st, coord, candidate, dwell })
    // a line target arms on acquisition (dwellFor = 0): the haptic says so, the way the timer
    // below does for a symbol whose ring has closed
    if (dwell.armed && !st.dwell.armed) buzz()
    // A finger that has found its target STOPS MOVING — and then no pointermove fires, so
    // `advanceDwell` alone would never reach `armed`. This timer is what actually closes the
    // ring (the visible fill is the CSS twin of it) and ticks the haptics.
    if (candidate && !dwell.armed) {
      dwellTimer.current = setTimeout(() => {
        const cur = endpointDragRef.current
        if (!cur || cur.candidate?.key !== candidate.key) return
        setEndpointDrag({ ...cur, dwell: { ...cur.dwell, armed: true } })
        buzz()
      }, Math.max(0, dwellFor(candidate) - (Date.now() - dwell.since)))
    }
  }
  const finishEndpointDrag = () => {
    const st = endpointDragRef.current
    if (!st) return
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    if (st.carry) { carry.end(st.carry, st.coord); setEndpointDrag(null); return }
    // Ring lädt, dann schnappt es: ONLY a completed dwell attaches. Releasing while the ring is
    // still filling drops the endpoint free, right where the finger left it — that is the whole
    // prevention story, and it needs no mode to leave.
    // The other half is the release ring: an endpoint that is STILL attached (`st.attached`)
    // never got pulled far enough, so nothing is written and the resolver springs it back.
    if (st.dwell.armed && st.candidate) {
      const target = st.candidate.target
      const entity = target.kind === 'object' ? entities.find((e) => e.id === target.id) : null
      const port = target.kind === 'line' ? st.candidate.port ?? nextFreePort(attachmentLines, target.id, target.endpoint) ?? undefined : undefined
      const attachment: LineAttachment = {
        target, port, routing: st.candidate.defaultRouting ?? 'direct',
        ...(target.kind === 'object' && entity?.live ? { gps: { state: 'guarded' as const, confirmedAt: entity.coord, lastSafe: entity.coord } } : {}),
      }
      onDrawingAttachment?.(st.id, st.endpoint, attachment, st.coord)
    } else if (!st.attached) onDrawingAttachment?.(st.id, st.endpoint, undefined, st.coord)
    setEndpointDrag(null)
  }

  /** The draft magnet's phases as the canvas gestures report them (useMapCanvasGestures ·
   *  onFreehandPointer, and the node taps on <Map>). A node-mode line's START is its first tap;
   *  every freehand stroke and every other tap aims for itself (lib/useDraftMagnet). */
  const updateDraftMagnet = (phase: 'start' | 'move' | 'end', coord: LngLat): DraftAttachments | void => {
    if (!mapInst.current) return
    if (phase === 'start') draftMagnet.start(coord, draft.kind === 'line' && !draft.freehand ? draft.length === 0 : true)
    else if (phase === 'move') draftMagnet.move(coord)
    else return draftMagnet.end()
  }
  const nodeMagnetActive = draft.kind === 'line' && !draft.freehand && !!draft.onPointAttachment
  const finishDraftNodeMagnet = (coord: LngLat) => {
    const out = updateDraftMagnet('end', coord)
    draft.onPointAttachment?.(out?.startAttachment ?? out?.endAttachment)
  }

  /** The joints a gesture in progress is coupled onto — the «Angekuppelt» rings (lib/useDraftMagnet
   *  · joinTargets), at each target's stored point and in the TARGET line's ink, since the ring
   *  sits on its node. */
  const joinPreview = joinTargets(draftMagnet.state, endpointDrag).flatMap((c) => (c.at
    ? [{ key: c.key, coord: c.at as LngLat, color: storedDrawings.find((d) => d.id === c.target.id)?.color || DEFAULT_INK }] : []))

  return {
    endpointDrag, attachmentLines, beginEndpointDrag, moveEndpointDrag, finishEndpointDrag,
    /** the draft's live magnet (its ConnectRing), and the claim its first end has made so far */
    // a node draft's later taps each run their own magnet session, so the first tap's banked
    // claim is read from the draft (the Plan's rule, usePlanDraft · planCandidatesAt)
    draftMagnetState: draftMagnet.state, draftStart: () => draftMagnet.current()?.startAttachment ?? (draft.length ? draft.startAttachment : undefined),
    updateDraftMagnet, nodeMagnetActive, finishDraftNodeMagnet, joinPreview,
  }
}
