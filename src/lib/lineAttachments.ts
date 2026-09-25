import type { BoardAnno, BoardPoint, Drawing, Entity, GpsFollowState, LineAttachment, LineEndpoint, LineRoutingMode, LngLat } from '../types'
import { rdpIndices } from './lineStyle'

export type Point = [number, number]
export type TargetFootprint =
  | { shape: 'circle'; center: Point; radius: number }
  | { shape: 'rect'; center: Point; width: number; height: number; rotation?: number }

export interface MagneticTarget {
  key: string
  target: LineAttachment['target']
  point: Point
  footprint?: TargetFootprint
  capacity?: number
  usedPorts?: number[]
  blocked?: boolean
  defaultRouting?: LineRoutingMode
  port?: number
}

/**
 * What a Leitung endpoint, a placement and a Rotation end may dock onto — ONE list per frame,
 * because it used to be four hand-maintained copies (MapView · candidatesAt and
 * trackPlaceMagnet, MapMarkers · trackEndMagnet, Whiteboard · planCandidatesAt) and nothing
 * stopped them drifting apart.
 *
 * Only objects that STATE A PLACE: a symbol, a vehicle, a crew. A Fläche is ground, a note is
 * paper, a Form is a silhouette — none of them is somewhere a hose ends.
 */
export const MAGNET_ENTITY_KINDS: readonly Entity['kind'][] = ['symbol', 'vehicle', 'team']
export const isMagnetEntity = (e: Pick<Entity, 'kind'>): boolean => MAGNET_ENTITY_KINDS.includes(e.kind)
/** …and the same set in the Plan's own vocabulary (a Trupp chip is a `resource` there). */
export const MAGNET_ANNO_KINDS: readonly NonNullable<BoardAnno['kind']>[] = ['symbol', 'resource']
export const isMagnetAnno = (a: Partial<Pick<BoardAnno, 'kind'>>): boolean => !!a.kind && MAGNET_ANNO_KINDS.includes(a.kind)

export const MAGNET_RADIUS_PX = 32
/** How long a line endpoint has to hold still on a SYMBOL / vehicle / Trupp before it attaches
 *  (the «Ring lädt, dann schnappt es» fill below). 350 ms until 14.09.: in the field a hose
 *  passing OVER a symbol on its way somewhere else kept snapping to it, so the ring is slower.
 *  A LINE target has no dwell at all — see `dwellFor`. */
export const MAGNET_DWELL_MS = 500
/** The dwell a magnetic target asks for, by what it is (14.09.) — the ONE place the two
 *  behaviours are told apart, read by every snap site on both surfaces and by their rings:
 *  - a LINE target (another line's end, a Teilstück prong) attaches INSTANTLY. Putting a stroke
 *    on a line end almost always means «continue from here», so a ring there was only a wait;
 *  - a SYMBOL / vehicle / Trupp target keeps the `MAGNET_DWELL_MS` fill, because those are what
 *    a moving line passes over by accident.
 *  A dwell of 0 draws no ring: there is nothing filling up to show. */
export const dwellFor = (target: Pick<MagneticTarget, 'target'> | null | undefined): number =>
  target?.target.kind === 'line' ? 0 : MAGNET_DWELL_MS
/** …and the same magnet aimed from the other side: a Trupp's MARKER dropped on the free end of a
 *  hose (15.09.2026, «Ein Etikett»). Deliberately wider than the 32 px every endpoint uses,
 *  because the two gestures aim with different things. An endpoint is dragged BY the very point
 *  that has to land in the socket — the finger is the target, and 32 px is generous. A Trupp
 *  marker is dragged by its body, but the thing that has to reach the coupling is its LEFT EDGE:
 *  the dot/cap sits on the coordinate with a name and a Leitung field hanging off to
 *  the right, so the hand is nowhere near the point being aimed. 44 px is the reach that lets the
 *  dot find the hose end while the pill still clears it. The dwell (`MAGNET_DWELL_MS`) is
 *  unchanged: «Ring lädt, dann schnappt es» is one gesture everywhere. */
export const TEAM_JOIN_RADIUS_PX = 44
export const DETACH_RADIUS_PX = 44
export const GPS_GUARD_METRES = 20
/** How far a fresh stroke may travel from its pointerDOWN point and still count as being «at the
 *  start». Inside it the instantly armed line-START claim (see `armDwell`) still belongs to the
 *  first point, so a SHORT stroke begun on a symbol attaches there; beyond it the far end has to
 *  earn its own ring. Both surfaces read this one number — the Plan used to drop the claim on the
 *  first pixel of movement, which is why a short Leitung docked on the Lage and not on the Plan. */
export const STROKE_START_RADIUS_PX = 10

/** How far INSIDE the target glyph an attached endpoint is placed (screen px).
 *
 *  The endpoint used to sit a few px OUTSIDE the glyph box, which read as "almost, but not
 *  quite joined" — the classic hose that stops short of the vehicle. It ends under the glyph
 *  instead: the symbol chip is a DOM element painted above the line on both surfaces (map
 *  markers over the GL canvas, whiteboard symbols after the strokes), so the overlap is
 *  invisible and the coupling reads as closed.
 *
 *  Half the stroke covers the ROUND CAP, which juts half a stroke past the endpoint; the
 *  extra 2 px swallow the chip's soft shadow. */
export const attachInsetPx = (strokeWidth = 4) => strokeWidth / 2 + 2

export const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Teilstück fork geometry — single source of truth shared by the drawn fork glyph
 *  (`TeilstueckFork` in lineDecor) and the three branch attach-ports, so the outputs always
 *  land on the visible prong tips instead of a separate offset overlay. `width` = line stroke.
 *  Sized generously so the three prongs are far enough apart to aim a branch at the middle one
 *  on a touch screen (the prong pitch = `half`, so a bigger half = fatter, more tappable ports). */
export function forkDims(width = 4) {
  const half = Math.max(14, width * 2.8)  // spine half-height / prong pitch
  return { half, prong: half * 1.1 }      // prong length, forward
}
/** Screen-px position of Teilstück port `port` (0 = top, 1 = middle, 2 = bottom): the tip of the
 *  matching fork prong — `prong` forward along tip→travel and `(port-1)*half` across it. Falls
 *  back to the bare tip when the segment is degenerate. */
export function forkPortPoint(tip: Point, neighbor: Point, width: number, port: number): Point {
  const { half, prong } = forkDims(width)
  const dx = tip[0] - neighbor[0], dy = tip[1] - neighbor[1], len = Math.hypot(dx, dy) || 1
  const fx = dx / len, fy = dy / len                 // forward unit (tip travel direction)
  const perp = (port - 1) * half                     // perpendicular unit is (-fy, fx)
  return [tip[0] + fx * prong - fy * perp, tip[1] + fy * prong + fx * perp]
}

/** Nearest eligible target in screen space. Stable key ordering breaks exact-distance ties. */
export function nearestMagneticTarget(pointer: Point, targets: MagneticTarget[], radius = MAGNET_RADIUS_PX): MagneticTarget | null {
  return targets
    .filter((t) => !t.blocked && distance(pointer, t.point) <= radius && (t.capacity == null || (t.usedPorts?.length ?? 0) < t.capacity))
    .sort((a, b) => distance(pointer, a.point) - distance(pointer, b.point) || a.key.localeCompare(b.key))[0] ?? null
}
/** Hysteresis around the magnetic pick: keep holding the current target until the pointer leaves a
 *  larger `keep` radius, and only switch to another when it's clearly closer. Kills the flicker of
 *  jitter at the acquire boundary and the hop between a Teilstück's three close prongs — the source
 *  of the twitchy snapped endpoint. Falls back to the plain nearest when nothing is held. */
export function stickyMagneticTarget(pointer: Point, targets: MagneticTarget[], prevKey: string | null, radius = MAGNET_RADIUS_PX, keep = DETACH_RADIUS_PX): MagneticTarget | null {
  const usable = (t: MagneticTarget) => !t.blocked && (t.capacity == null || (t.usedPorts?.length ?? 0) < t.capacity)
  const held = prevKey ? targets.find((t) => t.key === prevKey && usable(t)) : null
  if (held && distance(pointer, held.point) <= keep) {
    const nearest = nearestMagneticTarget(pointer, targets, radius)
    if (nearest && nearest.key !== held.key && distance(pointer, nearest.point) <= distance(pointer, held.point) - 8) return nearest
    return held
  }
  return nearestMagneticTarget(pointer, targets, radius)
}

/**
 * ── Ring lädt, dann schnappt es ────────────────────────────────────────────────────────────
 *
 * The arming state of ONE magnetic acquisition, shared by all four snap sites (Lage endpoint
 * drag, Lage draft stroke, Plan endpoint drag, Plan draft stroke).
 *
 * `armed` is the whole contract: **not armed = nothing attaches, not even on release.** Until
 * 25.08. the endpoint-drag and draft paths attached whenever a candidate happened to be under
 * the finger at lift-off, and `armed` only drove a decoration — so in the field a hose line
 * dropped near a vehicle silently coupled to it, and the only way to notice was the geometry
 * moving by itself later. The dwell now gates the commit, and the chip's ring (components ·
 * NodeDeleteChip, tone «connect») is an honest picture of this state: it fills over `dwellMs`,
 * and only a full ring attaches.
 *
 * Prevention needs no mode and no toggle: keep the finger moving, or let go before the ring
 * closes. Switching candidate restarts the fill (`since` moves), which is also what the
 * renderer keys its CSS animation on.
 */
export interface DwellState { key: string | null; since: number; armed: boolean }
export const EMPTY_DWELL: DwellState = { key: null, since: 0, armed: false }

/** Pure hover/dwell reducer. Switching candidate restarts the fill, whose length the candidate
 *  itself dictates (`dwellFor`): a line target's dwell is 0, so it is armed the moment it is
 *  acquired; a symbol's is `MAGNET_DWELL_MS`. Once armed, a target stays armed. */
export function advanceDwell(prev: DwellState, candidate: Pick<MagneticTarget, 'key' | 'target'> | null, now: number): DwellState {
  if (!candidate) return EMPTY_DWELL
  const since = prev.key === candidate.key ? prev.since : now
  const armed = (prev.key === candidate.key && prev.armed) || now - since >= dwellFor(candidate)
  return { key: candidate.key, since, armed }
}

/** The line-START exception: a NEW stroke whose pointerDOWN already lands inside a target's
 *  radius is deliberate aim — you put the finger on the Teilstück's prong *because* that is
 *  where the branch begins. There is nothing to hesitate about, so it arms at once and the ring
 *  is drawn full. Only acquisitions made LATER in the same gesture go through `advanceDwell`. */
export function armDwell(candidateKey: string | null, now: number): DwellState {
  return candidateKey ? { key: candidateKey, since: now, armed: true } : EMPTY_DWELL
}

/** Unlock is the same ring, in red, at the socket the endpoint is leaving — but driven by
 *  DISTANCE, not time: pull past `radius` and the link is off, stop short and release and the
 *  endpoint springs back where it was. Dragging is therefore never a silent detach, and never a
 *  timed one either — the operator's own hand runs the ring. */
export function detachProgress(origin: Point, pointer: Point, radius = DETACH_RADIUS_PX): number {
  return Math.max(0, Math.min(1, distance(origin, pointer) / radius))
}

/** Below this much of the release ring nothing is drawn, so nudging an attached endpoint by a
 *  few px never flashes red under the finger (the same courtesy `NODE_HOLD_ARM_MS` pays the
 *  hold-to-delete chip). ≈8 px of the 44 px detach radius. */
export const DETACH_SHOW_PROGRESS = 0.18

/** Intersection of the ray centre→toward with a padded, optionally rotated footprint. */
export function boundaryPoint(footprint: TargetFootprint, toward: Point, padding = 5): Point {
  const [cx, cy] = footprint.center
  let dx = toward[0] - cx
  const dy = toward[1] - cy
  if (Math.hypot(dx, dy) < 1e-9) dx = 1
  if (footprint.shape === 'circle') {
    const k = (footprint.radius + padding) / Math.hypot(dx, dy)
    return [cx + dx * k, cy + dy * k]
  }
  const r = -((footprint.rotation ?? 0) * Math.PI) / 180
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  const hw = footprint.width / 2 + padding, hh = footprint.height / 2 + padding
  const k = Math.min(hw / Math.max(Math.abs(lx), 1e-9), hh / Math.max(Math.abs(ly), 1e-9))
  const x = lx * k, y = ly * k
  const rr = -r
  return [cx + x * Math.cos(rr) - y * Math.sin(rr), cy + x * Math.sin(rr) + y * Math.cos(rr)]
}

export type Coordinate = [number, number, ...number[]]
export interface AttachableLine<P extends Coordinate = Point> {
  id: string
  points: P[]
  teilstueck?: boolean
  width?: number
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}

export const attachmentAt = <P extends Coordinate>(line: AttachableLine<P>, endpoint: LineEndpoint) => endpoint === 'start' ? line.startAttachment : line.endAttachment
export const endpointPoint = <P extends Coordinate>(line: AttachableLine<P>, endpoint: LineEndpoint): P | undefined =>
  endpoint === 'start' ? line.points[0] : line.points[line.points.length - 1]

/** A normal endpoint accepts one branch; the -E end accepts three outgoing branches. */
export function endpointCapacity<P extends Coordinate>(line: AttachableLine<P>, endpoint: LineEndpoint): number {
  return endpoint === 'end' && !!line.teilstueck ? 3 : 1
}

/** A line end that hangs free, with the surface's own px position of that end. */
export interface FreeEndpoint {
  lineId: string
  endpoint: LineEndpoint
  point: Point
}

/**
 * The nearest FREE line end under a point, in the surface's px space — the magnet read backwards.
 *
 * `nearestMagneticTarget` answers «what may this endpoint dock onto»; this answers «which
 * endpoint is lying under what I just dropped here», which is what a Trupp marker dropped on the
 * end of a Leitung needs (lib/truppLines · the automatic hose ↔ Trupp join). Only the two ENDS
 * count — a marker beside the middle of a hose says nothing about who works it — and only ends
 * that are not already docked somewhere: an attached end keeps what it is attached to. Same
 * `MAGNET_RADIUS_PX` as every other snap, so «close enough» means one thing on both surfaces.
 *
 * `toPx` projects a stored point into that px space (map projection on the Karte, sheet fractions
 * × board size on a Plan), so the geometry lives here once and neither surface repeats it.
 */
export function nearestFreeEndpoint<P extends Coordinate>(
  at: Point, lines: AttachableLine<P>[], toPx: (p: P) => Point, radius = MAGNET_RADIUS_PX,
  /** which ends may answer – a Trupp joins a hose at its END only (15.09.): the arrow end is
   *  where the crew works, the start is where the water comes from */
  endpoints: readonly LineEndpoint[] = ['start', 'end'],
): FreeEndpoint | null {
  let best: (FreeEndpoint & { d: number }) | null = null
  for (const line of lines) {
    if (line.points.length < 2) continue
    for (const endpoint of endpoints) {
      if (attachmentAt(line, endpoint)) continue
      const stored = endpointPoint(line, endpoint)
      if (!stored) continue
      const point = toPx(stored)
      const d = distance(at, point)
      // stable on an exact tie, the way nearestMagneticTarget is
      if (d > radius || (best && (d > best.d || (d === best.d && line.id >= best.lineId)))) continue
      best = { lineId: line.id, endpoint, point, d }
    }
  }
  return best ? { lineId: best.lineId, endpoint: best.endpoint, point: best.point } : null
}

export function incomingAttachments<P extends Coordinate>(lines: AttachableLine<P>[], targetId: string, endpoint: LineEndpoint) {
  return lines.flatMap((line) => (['start', 'end'] as const).flatMap((sourceEndpoint) => {
    const a = attachmentAt(line, sourceEndpoint)
    return a?.target.kind === 'line' && a.target.id === targetId && a.target.endpoint === endpoint
      ? [{ lineId: line.id, sourceEndpoint, attachment: a }]
      : []
  }))
}

export function nextFreePort<P extends Coordinate>(lines: AttachableLine<P>[], targetId: string, endpoint: LineEndpoint): number | null {
  const target = lines.find((l) => l.id === targetId)
  if (!target) return null
  const used = new Set(incomingAttachments(lines, targetId, endpoint).map((x) => x.attachment.port ?? 0))
  for (let p = 0; p < endpointCapacity(target, endpoint); p++) if (!used.has(p)) return p
  return null
}

/** Directed dependency graph: source line follows target line. Adding source→target may not
 *  make target reach source, directly or through a longer chain. */
export function wouldCreateCycle<P extends Coordinate>(lines: AttachableLine<P>[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true
  const byId = new Map(lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const visit = (id: string): boolean => {
    if (id === sourceId) return true
    if (seen.has(id)) return false
    seen.add(id)
    const line = byId.get(id)
    if (!line) return false
    return (['start', 'end'] as const).some((ep) => {
      const a = attachmentAt(line, ep)
      return a?.target.kind === 'line' && visit(a.target.id)
    })
  }
  return visit(targetId)
}

export function relationshipNetwork<P extends Coordinate>(lines: AttachableLine<P>[], seedLineIds: string[] = [], seedObjectIds: string[] = []) {
  const lineIds = new Set(seedLineIds), objectIds = new Set(seedObjectIds)
  const depth = new globalThis.Map<string, number>()
  seedLineIds.forEach((id) => depth.set(`line:${id}`, 0)); seedObjectIds.forEach((id) => depth.set(`object:${id}`, 0))
  let changed = true
  while (changed) {
    changed = false
    for (const line of lines) for (const ep of ['start', 'end'] as const) {
      const a = attachmentAt(line, ep); if (!a) continue
      const sourceKey = `line:${line.id}`, targetKey = `${a.target.kind}:${a.target.id}`
      const sd = depth.get(sourceKey), td = depth.get(targetKey)
      if (sd != null && td == null) { depth.set(targetKey, sd + 1); a.target.kind === 'line' ? lineIds.add(a.target.id) : objectIds.add(a.target.id); changed = true }
      if (td != null && sd == null) { depth.set(sourceKey, td + 1); lineIds.add(line.id); changed = true }
    }
  }
  return { lineIds, objectIds, depth }
}

export interface ResolveContext<P extends Coordinate = Point> {
  lines: AttachableLine<P>[]
  /** `source` is the line being resolved — its stroke width decides how far the endpoint
   *  tucks under the glyph (see attachInsetPx). */
  objectPoint: (id: string, toward: P, attachment: LineAttachment, source: AttachableLine<P>) => P | null
  linePoint?: (target: AttachableLine<P>, endpoint: LineEndpoint, attachment: LineAttachment, resolved: P, toward: P) => P
}

/** Resolve relationship intent without mutating stored fallback geometry. Dangling/cyclic data
 *  fails safe by returning the stored point. */
export function resolveLinePoints<P extends Coordinate>(line: AttachableLine<P>, ctx: ResolveContext<P>, stack = new Set<string>()): P[] {
  const points = line.points.map((p) => [...p] as P)
  if (points.length < 2 || stack.has(line.id)) return points
  const nextStack = new Set(stack).add(line.id)
  for (const ep of ['start', 'end'] as const) {
    const a = attachmentAt(line, ep)
    if (!a) continue
    const idx = ep === 'start' ? 0 : points.length - 1
    const neighbor = points[ep === 'start' ? 1 : points.length - 2]
    let resolved: P | null = null
    if (a.target.kind === 'object') resolved = ctx.objectPoint(a.target.id, neighbor, a, line)
    else {
      const target = ctx.lines.find((l) => l.id === a.target.id)
      if (target && !nextStack.has(target.id)) {
        resolved = endpointPoint({ ...target, points: resolveLinePoints(target, ctx, nextStack) }, a.target.endpoint) ?? null
        if (resolved && ctx.linePoint) resolved = ctx.linePoint(target, a.target.endpoint, a, resolved, neighbor)
      }
    }
    if (resolved) points[idx] = [...resolved] as P
  }
  return points
}

/** The other end. */
const otherEndpoint = (ep: LineEndpoint): LineEndpoint => (ep === 'start' ? 'end' : 'start')

/** What a «Richtung umkehren» costs: the line's own two attachments, plus the corrected target of
 *  every attachment that pointed AT one of its ends. */
export interface LineFlip<P extends Coordinate> {
  points: P[]
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
  /** other lines hanging on this one: `endpoint` is which of THEIR ends carries `attachment` */
  incoming: { lineId: string; endpoint: LineEndpoint; attachment: LineAttachment }[]
}

/**
 * Reverse a line's point order, so the arrow / Teilstück-«E» / distance label move to the other
 * end. The geometry does not move — only which coordinate is called «start».
 *
 * Every attachment therefore travels WITH ITS COORDINATE, in both directions:
 * - the line's own two attachments swap places (what hung on the last point now hangs on the first);
 * - every OTHER line that was hooked to this line's `end` is rewritten to `start`, and back —
 *   otherwise a branch coupled to the tip of a hose would leap to its other end the moment the
 *   Abschluss was flipped, which is the one thing a flip must never do.
 *
 * Pure: the caller applies `points` + the two attachments to the line and each `incoming` entry to
 * its own line, in ONE commit (one undo step). Both surfaces call this — Lage useMapDrawing ·
 * reverseDrawing and Plan Whiteboard · reverseAnno.
 */
export function flipLine<P extends Coordinate>(line: AttachableLine<P>, lines: AttachableLine<P>[] = []): LineFlip<P> {
  const incoming = lines.flatMap((other) => (other.id === line.id ? [] : (['start', 'end'] as const).flatMap((ep) => {
    const a = attachmentAt(other, ep)
    return a?.target.kind === 'line' && a.target.id === line.id
      ? [{ lineId: other.id, endpoint: ep, attachment: { ...a, target: { ...a.target, endpoint: otherEndpoint(a.target.endpoint) } } }]
      : []
  })))
  return {
    points: [...line.points].reverse(),
    startAttachment: line.endAttachment,
    endAttachment: line.startAttachment,
    incoming,
  }
}

export function materializeEndpoint<P extends Coordinate>(line: AttachableLine<P>, endpoint: LineEndpoint, resolved: P): AttachableLine<P> {
  const points = line.points.map((p, i) => i === (endpoint === 'start' ? 0 : line.points.length - 1) ? [...resolved] as P : p)
  return { ...line, points, ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
}

/** Body movement leaves attached endpoints fixed; every other vertex translates. */
export function moveLineBody<P extends Coordinate>(line: AttachableLine<P>, delta: Point): P[] {
  return line.points.map((p, i) => {
    if ((i === 0 && line.startAttachment) || (i === line.points.length - 1 && line.endAttachment)) return [...p] as P
    const next = [...p] as P; next[0] += delta[0]; next[1] += delta[1]; return next
  })
}

/** Trace appends movement beside the endpoint and simplifies only the newly sampled route. */
export function applyRouting<P extends Coordinate>(points: P[], endpoint: LineEndpoint, next: P, mode: LineRoutingMode, epsilon = 1): P[] {
  const out = points.map((p) => [...p] as P)
  const idx = endpoint === 'start' ? 0 : out.length - 1
  if (mode === 'direct' || out.length < 2) { out[idx] = [...next] as P; return out }
  // Only the active sampling tail is eligible for simplification. Older vertices are already
  // committed route history and must survive later samples (especially a deliberate return).
  const tail = endpoint === 'start' ? [[...next] as P, ...out.slice(0, 2)] : [...out.slice(-2), [...next] as P]
  const keep = rdpIndices(tail.map((p) => [p[0], p[1]]), epsilon)
  const simplified = keep.map((i) => tail[i])
  return endpoint === 'start' ? [...simplified, ...out.slice(2)] : [...out.slice(0, -2), ...simplified]
}

export type GpsGuardResult = { state: GpsFollowState; point: Point; exceeded: boolean }
export function gpsGuard(state: GpsFollowState, confirmedAt: Point, lastSafe: Point, target: Point, metresBetween: (a: Point, b: Point) => number): GpsGuardResult {
  if (state === 'paused') return { state, point: lastSafe, exceeded: false }
  if (state === 'continuous') return { state, point: target, exceeded: false }
  if (metresBetween(confirmedAt, target) >= GPS_GUARD_METRES) return { state: 'paused', point: lastSafe, exceeded: true }
  return { state, point: target, exceeded: false }
}

/** Local metres for the guard, off the map export's own flat approximation (no projection here). */
const flatMetres = (a: Point, b: Point) => {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180
  return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(lat), (b[1] - a[1]) * 110540)
}

/**
 * Does this attached end sit ON its target right now — or does the live-GPS guard hold it
 * elsewhere? A paused end (the vehicle drove off) resolves to `lastSafe`, on site, and so does a
 * guarded one whose vehicle is already past the guard: the line does NOT end at the vehicle then.
 *
 * ⚠️ The printed Kroki reads this (krokiPayload · `startAt`/`endAt`): the server re-couples every
 * end it is told about to the target glyph AS PRINTED (backend · kroki · `_snap_attached_ends`),
 * and a paused hose whose TLF stood at its depot was drawn from the site to the depot on
 * paper while the screen showed it ending on site. An end the guard holds is not coupled on paper.
 */
export function endOnTarget(attachment: LineAttachment, targetCoord: LngLat): boolean {
  if (!attachment.gps) return true
  const g = attachment.gps
  const p = gpsGuard(g.state, g.confirmedAt, g.lastSafe, targetCoord, flatMetres).point
  return p[0] === targetCoord[0] && p[1] === targetCoord[1]
}

/** Non-interactive/map-export adapter. Uses a small ground footprint so fitting, Kroki and
 *  reports consume resolved geometry even without a browser projection. The live map adapter
 *  uses the exact current screen glyph rectangle instead. */
export function resolveMapDrawings(drawings: Drawing[], entities: Entity[], radiusM = 4): Drawing[] {
  const lines: AttachableLine<LngLat>[] = drawings.filter((d) => d.kind === 'line' && d.coords.length >= 2)
    .map((d) => ({ id: d.id, points: d.coords, teilstueck: d.teilstueck, startAttachment: d.startAttachment, endAttachment: d.endAttachment }))
  const objectPoint = (id: string, toward: LngLat, attachment: LineAttachment): LngLat | null => {
    const e = entities.find((x) => x.id === id)
    if (!e) return attachment.gps?.lastSafe ?? null
    let center = e.coord
    if (attachment.gps) {
      center = gpsGuard(attachment.gps.state, attachment.gps.confirmedAt, attachment.gps.lastSafe, center, flatMetres).point as LngLat
    }
    const cos = Math.cos(center[1] * Math.PI / 180) || 1e-6
    const localToward: Point = [(toward[0] - center[0]) * 111320 * cos, (center[1] - toward[1]) * 110540]
    // negative padding for the same reason as on screen: the glyph paints over the line, so an
    // endpoint slightly inside it reads as coupled, one slightly outside as "not quite joined"
    const p = boundaryPoint({ shape: 'rect', center: [0, 0], width: radiusM * 2.4, height: radiusM * 2, rotation: e.rotation }, localToward, -1)
    return [center[0] + p[0] / (111320 * cos), center[1] - p[1] / 110540]
  }
  const linePoint = (target: AttachableLine<LngLat>, endpoint: LineEndpoint, attachment: LineAttachment, resolved: LngLat): LngLat => {
    if (!(endpoint === 'end' && target.teilstueck) || attachment.port == null || target.points.length < 2) return resolved
    const q = target.points[target.points.length - 2], cos = Math.cos(resolved[1] * Math.PI / 180) || 1e-6
    const dx = (resolved[0] - q[0]) * 111320 * cos, dy = (resolved[1] - q[1]) * 110540, len = Math.hypot(dx, dy) || 1
    const fx = dx / len, fy = dy / len                              // forward unit (metres)
    const fwd = 1.5, perp = (attachment.port - 1) * 1.5             // fork-shaped fan onto the prong tips
    const ox = fx * fwd - fy * perp, oy = fy * fwd + fx * perp
    return [resolved[0] + ox / (111320 * cos), resolved[1] + oy / 110540]
  }
  const resolved = new globalThis.Map(lines.map((l) => [l.id, resolveLinePoints(l, { lines, objectPoint, linePoint })]))
  return drawings.map((d) => resolved.has(d.id) ? { ...d, coords: resolved.get(d.id)! } : d)
}

/** Plan/export adapter with per-vertex floors. Object footprints are normalized to the same
 *  quiet boundary used by the whiteboard; missing targets retain fallback points. */
export function resolvePlanAnnos(annos: BoardAnno[]): BoardAnno[] {
  const lines: AttachableLine<BoardPoint>[] = annos.filter((a) => a.kind === 'draw' && (a.pts?.length ?? 0) >= 2)
    .map((a) => ({ id: a.id, points: a.pts!, teilstueck: a.teilstueck, startAttachment: a.startAttachment, endAttachment: a.endAttachment }))
  const objectPoint = (id: string, toward: BoardPoint): BoardPoint | null => {
    const a = annos.find((x) => x.id === id && (x.kind === 'symbol' || x.kind === 'resource'))
    if (!a || a.x == null || a.y == null) return null
    const p = boundaryPoint({ shape: 'rect', center: [a.x, a.y], width: a.kind === 'resource' ? 0.15 : 0.08, height: a.kind === 'resource' ? 0.07 : 0.08, rotation: a.rotation }, [toward[0], toward[1]], -0.006)
    return [p[0], p[1], a.floor ?? 0]
  }
  const linePoint = (target: AttachableLine<BoardPoint>, endpoint: LineEndpoint, attachment: LineAttachment, resolved: BoardPoint): BoardPoint => {
    if (!(endpoint === 'end' && target.teilstueck) || attachment.port == null || target.points.length < 2) return resolved
    const q = target.points[target.points.length - 2], dx = resolved[0] - q[0], dy = resolved[1] - q[1], len = Math.hypot(dx, dy) || 1
    const fx = dx / len, fy = dy / len, fwd = 0.012, perp = (attachment.port - 1) * 0.012   // fork-shaped fan
    return [resolved[0] + fx * fwd - fy * perp, resolved[1] + fy * fwd + fx * perp, resolved[2] ?? q[2] ?? 0]
  }
  const resolved = new globalThis.Map(lines.map((l) => [l.id, resolveLinePoints(l, { lines, objectPoint, linePoint })]))
  return annos.map((a) => resolved.has(a.id) ? { ...a, pts: resolved.get(a.id)! } : a)
}
