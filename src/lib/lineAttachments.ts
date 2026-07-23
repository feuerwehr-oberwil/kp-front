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

export const MAGNET_RADIUS_PX = 32
export const MAGNET_DWELL_MS = 350
export const DETACH_RADIUS_PX = 44
export const GPS_GUARD_METRES = 20

export const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Teilstück fork geometry — single source of truth shared by the drawn fork glyph
 *  (`TeilstueckFork` in lineDecor) and the three branch attach-ports, so the outputs always
 *  land on the visible prong tips instead of a separate offset overlay. `width` = line stroke. */
export function forkDims(width = 4) {
  const half = Math.max(8, width * 1.7)   // spine half-height
  return { half, prong: half * 1.05 }     // prong length, forward
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
export function nearestBlockedTarget(pointer: Point, targets: MagneticTarget[], radius = MAGNET_RADIUS_PX): MagneticTarget | null {
  return targets.filter((t) => !!t.blocked && distance(pointer, t.point) <= radius)
    .sort((a, b) => distance(pointer, a.point) - distance(pointer, b.point) || a.key.localeCompare(b.key))[0] ?? null
}

export interface DwellState { key: string | null; since: number; armed: boolean }
export const EMPTY_DWELL: DwellState = { key: null, since: 0, armed: false }

/** Pure hover/dwell reducer; switching candidate always restarts the 350 ms fill. */
export function advanceDwell(prev: DwellState, candidateKey: string | null, now: number, dwellMs = MAGNET_DWELL_MS): DwellState {
  if (!candidateKey) return EMPTY_DWELL
  if (prev.key !== candidateKey) return { key: candidateKey, since: now, armed: false }
  return { ...prev, armed: prev.armed || now - prev.since >= dwellMs }
}

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

export function connectedNetwork<P extends Coordinate>(lines: AttachableLine<P>[], seedIds: string[]): Set<string> {
  const out = new Set(seedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const line of lines) {
      for (const ep of ['start', 'end'] as const) {
        const a = attachmentAt(line, ep)
        if (a?.target.kind !== 'line') continue
        if (out.has(line.id) || out.has(a.target.id)) {
          if (!out.has(line.id)) { out.add(line.id); changed = true }
          if (!out.has(a.target.id)) { out.add(a.target.id); changed = true }
        }
      }
    }
  }
  return out
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
  objectPoint: (id: string, toward: P, attachment: LineAttachment) => P | null
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
    if (a.target.kind === 'object') resolved = ctx.objectPoint(a.target.id, neighbor, a)
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

export function detachAffected<P extends Coordinate>(lines: AttachableLine<P>[], removedObjectIds: Set<string>, removedLineIds: Set<string>, resolve: (line: AttachableLine<P>) => P[]): AttachableLine<P>[] {
  return lines.filter((l) => !removedLineIds.has(l.id)).map((line) => {
    let next = line
    const resolved = resolve(line)
    for (const ep of ['start', 'end'] as const) {
      const a = attachmentAt(next, ep)
      const affected = a && (a.target.kind === 'object' ? removedObjectIds.has(a.target.id) : removedLineIds.has(a.target.id))
      if (affected) next = materializeEndpoint(next, ep, endpointPoint({ ...line, points: resolved }, ep)!)
    }
    return next
  })
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
      const metres = (a: Point, b: Point) => {
        const lat = ((a[1] + b[1]) / 2) * Math.PI / 180
        return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(lat), (b[1] - a[1]) * 110540)
      }
      center = gpsGuard(attachment.gps.state, attachment.gps.confirmedAt, attachment.gps.lastSafe, center, metres).point as LngLat
    }
    const cos = Math.cos(center[1] * Math.PI / 180) || 1e-6
    const localToward: Point = [(toward[0] - center[0]) * 111320 * cos, (center[1] - toward[1]) * 110540]
    const p = boundaryPoint({ shape: 'rect', center: [0, 0], width: radiusM * 2.4, height: radiusM * 2, rotation: e.rotation }, localToward, 1)
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
    const p = boundaryPoint({ shape: 'rect', center: [a.x, a.y], width: a.kind === 'resource' ? 0.15 : 0.08, height: a.kind === 'resource' ? 0.07 : 0.08, rotation: a.rotation }, [toward[0], toward[1]], 0.006)
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
