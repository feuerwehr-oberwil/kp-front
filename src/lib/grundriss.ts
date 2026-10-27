// The Gebäude floor plan («Grundriss») as LAYOUT on the storey stack: Durchgänge that sit on a
// Wand and ride along with it, «Kopieren nach …» of a storey's layout, and an object moved onto
// another storey. Pure – the Whiteboard and its gesture hooks call these and write the result
// through the board funnel (one ↶ per act). Rules: docs/plans-and-buildings.md › Grundriss.
//
// Coordinates are a tile's own: x a fraction of the tile's width, y of its height, so a distance
// or an angle needs the tile's aspect `ar` (height / width, lib/whiteboard · tileAspectOf). Every
// length here is in tile WIDTHS – a screen tolerance of N px is `N / boardWidthPx`.

import type { BoardAnno, BoardPoint } from '../types'
import { stackRange } from './stackFloors'

/** the one symbol that snaps onto a Wand (owner pick 2A, 27.10.2026) */
export const DOOR_SYMBOL = 'GB Ture Durchgang'
/** the symbol library's category «Kopieren nach …» carries along with the Wände */
export const GEBAEUDE_CATEGORY = 'Gebäude'
/** how near a Wand (screen px) a Durchgang has to be placed or dropped to sit on it */
export const DOOR_SNAP_PX = 30

export const isWall = (a: BoardAnno): boolean => a.kind === 'draw' && a.role === 'wand' && (a.pts?.length ?? 0) >= 2
export const isDoor = (a: BoardAnno): boolean => a.kind === 'symbol' && a.symbol === DOOR_SYMBOL

/** where a Durchgang sits down: the point on the wall, the wall's bearing there, how far off it was */
export interface WallSeat { wallId: string; x: number; y: number; rotation: number; dist: number }

const vFloor = (p: BoardPoint, a: BoardAnno) => p[2] ?? a.floor ?? 0
/** screen bearing of a→b in degrees, clockwise from +x (the CSS rotate of a symbol), 0…360 */
const bearing = (a: BoardPoint, b: BoardPoint, ar: number) => {
  const d = (Math.atan2((b[1] - a[1]) * ar, b[0] - a[0]) * 180) / Math.PI
  return ((d % 360) + 360) % 360
}
/** p projected onto segment a→b: the parameter t (0…1) and the distance, in tile widths */
function project(p: readonly [number, number], a: BoardPoint, b: BoardPoint, ar: number) {
  const dx = b[0] - a[0], dy = (b[1] - a[1]) * ar
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * ar * dy) / len2)) : 0
  const x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1])
  return { t, x, y, dist: Math.hypot(p[0] - x, (p[1] - y) * ar) }
}
/** the nearest segment pts[i] → pts[i + 1] of `wall` lying on `floor` to p, or null when it has
 *  none there; `a`/`b` are its ends */
function nearestSegment(wall: BoardAnno, floor: number, p: readonly [number, number], ar: number) {
  let best: { i: number; t: number; x: number; y: number; dist: number; a: BoardPoint; b: BoardPoint } | null = null
  const pts = wall.pts ?? []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    if (vFloor(a, wall) !== floor || vFloor(b, wall) !== floor) continue
    const r = project(p, a, b, ar)
    if (!best || r.dist < best.dist) best = { i, ...r, a, b }
  }
  return best
}

/**
 * The Wand a Durchgang placed or dropped at (x, y) on `floor` sits on: the nearest segment of
 * any `role: 'wand'` line on that storey within `maxDist` (tile widths), or null – it stands free.
 * The rotation is the segment's bearing folded into 0…180 (the glyph is symmetric).
 */
export function nearestWall(annos: readonly BoardAnno[], floor: number, x: number, y: number, ar: number, maxDist: number): WallSeat | null {
  let best: WallSeat | null = null
  for (const w of annos) {
    if (!isWall(w)) continue
    const s = nearestSegment(w, floor, [x, y], ar)
    if (!s || s.dist > maxDist || (best && s.dist >= best.dist)) continue
    best = { wallId: w.id, x: s.x, y: s.y, rotation: Math.round(bearing(s.a, s.b, ar)) % 180, dist: s.dist }
  }
  return best
}

/** a Durchgang seated on the wall `seat` names, or let go where it is (`seat` null clears onWall) */
export function seatDoor(door: BoardAnno, seat: WallSeat | null): BoardAnno {
  if (!seat) return door.onWall ? { ...door, onWall: undefined } : door
  return { ...door, x: seat.x, y: seat.y, rotation: seat.rotation, onWall: seat.wallId }
}

/** a door taken from wall `from` onto the same wall as it now stands (`to`) – see carryDoors */
function rideWall(door: BoardAnno, from: BoardAnno, to: BoardAnno, ar: number): BoardAnno {
  const floor = door.floor ?? 0
  const was = from.pts ?? [], pts = to.pts ?? []
  const p: [number, number] = [door.x ?? 0, door.y ?? 0]
  const at = nearestSegment(from, floor, p, ar) ?? (was.length ? nearestSegment(from, vFloor(was[0], from), p, ar) : null)
  if (!at || pts.length < 2) return door
  // the door's turn against its segment survives the move (0, or 180 for a door seated reversed)
  const off = (door.rotation ?? 0) - bearing(at.a, at.b, ar)
  let i = at.i, t = at.t
  // the same corners → the same place along the same segment, exact under a move or a turn; a
  // corner added or taken away → the nearest point of the new wall to where the door stood
  if (pts.length !== was.length) {
    const nf = vFloor(pts[0], to)
    const r = nearestSegment(to, floor, p, ar) ?? nearestSegment(to, nf, p, ar)
    if (!r) return { ...door, onWall: undefined }
    i = r.i; t = r.t
  }
  const a = pts[i], b = pts[i + 1]
  const nextFloor = vFloor(a, to)
  const delta = nextFloor - floor
  const rotation = (((bearing(a, b, ar) + off) % 360) + 360) % 360
  return {
    ...door,
    x: a[0] + t * (b[0] - a[0]),
    y: a[1] + t * (b[1] - a[1]),
    rotation,
    ...(delta ? { floor: nextFloor } : null),
    ...(delta && door.floorFrom != null ? { floorFrom: door.floorFrom + delta } : null),
    ...(delta && door.floorTo != null ? { floorTo: door.floorTo + delta } : null),
  }
}

/**
 * The Durchgänge of every Wand a write changed, carried along with it – applied to every board
 * write on its way out (Whiteboard · the board funnel), so a wall moved by its body, by the bar's
 * ✥ / ⟳, by a vertex grip or onto another storey takes its doors along in the SAME step.
 *
 *   · a wall whose points or storey changed: each of its doors keeps its place along the wall
 *     (same segment, same fraction) and its turn against it; a corner added or removed re-projects
 *     the door onto the nearest point of the new wall;
 *   · a wall the write deleted: its doors stay where they stand and let go (`onWall` cleared);
 *   · a door the write itself touched (dragged, or moved with its wall in one group) is left as
 *     written – it already says where it goes.
 *
 * Returns `next` itself when no door moved, so a write without doors costs one scan.
 */
export function carryDoors(prev: readonly BoardAnno[], next: BoardAnno[], ar: number): BoardAnno[] {
  if (!next.some((a) => a.onWall)) return next
  const before = new Map(prev.map((a) => [a.id, a]))
  const after = new Map(next.map((a) => [a.id, a]))
  let changed = false
  const out = next.map((d) => {
    if (!d.onWall || d.kind !== 'symbol' || before.get(d.id) !== d) return d
    const was = before.get(d.onWall), now = after.get(d.onWall)
    if (!was) return d // already standing free of a wall that was never here – not this write's doing
    if (!now || !isWall(now)) { changed = true; return { ...d, onWall: undefined } }
    if (was.pts === now.pts && was.floor === now.floor) return d
    const moved = rideWall(d, was, now, ar)
    if (moved !== d) changed = true
    return moved
  })
  return changed ? out : next
}

/** the Durchgänge sitting on one of the walls in `ids` (and not themselves in it) */
export const doorsOn = (annos: readonly BoardAnno[], ids: readonly string[]): BoardAnno[] =>
  annos.filter((a) => a.onWall && ids.includes(a.onWall) && !ids.includes(a.id))

/** whether `a` is drawn on storey `floor` (every vertex of a line, the range of a symbol) */
function onStorey(a: BoardAnno, floor: number): boolean {
  if (a.pts?.length) return a.pts.every((p) => vFloor(p, a) === floor)
  if (a.kind === 'symbol') {
    const { from, to } = stackRange(a)
    return floor >= Math.min(from, to) && floor <= Math.max(from, to)
  }
  return (a.floor ?? 0) === floor
}

/** What «Kopieren nach …» would copy from storey `from`: its Wände and its Gebäude-category
 *  symbols – never Leitungen, Trupps, Gefahren, Notizen or Messpunkte. */
export function grundrissOf(annos: readonly BoardAnno[], from: number, isGebaeude: (symbol: string) => boolean): BoardAnno[] {
  return annos.filter((a) => onStorey(a, from) && (
    (a.role === 'wand' && a.kind === 'draw')
    || (a.kind === 'symbol' && !!a.symbol && isGebaeude(a.symbol))))
}

/**
 * «Kopieren nach …»: the Grundriss of storey `from` (grundrissOf) as INDEPENDENT copies on every
 * storey in `targets` – new ids from `mint`, the target's `floor`, every per-vertex storey set to
 * it, a Durchgang's `onWall` pointing at the copy of its wall (or at nothing when its wall did not
 * come along). A ranged symbol (Treppe 0–3) already standing on a target is skipped there; every
 * other one lands with that storey as its only one. Line ends let go of what they were docked to
 * (that object stays on the source storey). The caller adds `added` on top of what is there.
 */
export function copyGrundriss(
  annos: readonly BoardAnno[], from: number, targets: readonly number[],
  isGebaeude: (symbol: string) => boolean, mint: (prefix: string) => string,
): { added: BoardAnno[]; counts: { floor: number; n: number }[] } {
  const source = grundrissOf(annos, from, isGebaeude)
  const added: BoardAnno[] = []
  const counts: { floor: number; n: number }[] = []
  for (const t of targets) {
    if (t === from) continue
    const ids = new Map<string, string>()
    const copies: BoardAnno[] = []
    for (const a of source) {
      if (a.kind === 'symbol' && (a.floorFrom != null || a.floorTo != null) && onStorey(a, t)) continue
      const id = mint(a.kind === 'symbol' ? 's' : a.kind === 'area' ? 'a' : 'l')
      ids.set(a.id, id)
      copies.push(a.pts
        ? { ...a, id, floor: t, pts: a.pts.map((p): BoardPoint => (p.length === 3 ? [p[0], p[1], t] : [p[0], p[1]])), startAttachment: undefined, endAttachment: undefined, truppId: undefined }
        : { ...a, id, floor: t, floorFrom: undefined, floorTo: undefined })
    }
    for (const c of copies) if (c.onWall) c.onWall = ids.get(c.onWall)
    added.push(...copies)
    counts.push({ floor: t, n: copies.length })
  }
  return { added, counts }
}

/**
 * `a` moved `delta` storeys up (negative: down) – its own storey, every vertex's, a symbol's
 * Von/Bis – or null when any of them would land on a storey the stack does not have (then it
 * stays where it is: one body, never torn). Used by the moves that drop a selection onto another
 * storey tile (useWbBodyDrag, useWbSelectionBar); x/y are the caller's.
 */
export function shiftStoreys(a: BoardAnno, delta: number, floors: readonly number[]): BoardAnno | null {
  if (!delta) return a
  const has = (f: number) => floors.includes(f)
  const home = (a.floor ?? 0) + delta
  if (!has(home)) return null
  if (a.pts?.some((p) => p[2] != null && !has(p[2] + delta))) return null
  if ((a.floorFrom != null && !has(a.floorFrom + delta)) || (a.floorTo != null && !has(a.floorTo + delta))) return null
  return {
    ...a,
    floor: home,
    ...(a.pts ? { pts: a.pts.map((p): BoardPoint => (p.length === 3 ? [p[0], p[1], p[2] + delta] : p)) } : null),
    ...(a.floorFrom != null ? { floorFrom: a.floorFrom + delta } : null),
    ...(a.floorTo != null ? { floorTo: a.floorTo + delta } : null),
  }
}

/**
 * What a Grundriss holds, by kind – the line «Kopieren nach …» (StoreyCopySheet) says it in:
 * how many Wände, and per Gebäude symbol how many, in the order they first appear. `items` is a
 * storey's grundrissOf.
 */
export function grundrissKinds(items: readonly BoardAnno[]): { walls: number; symbols: { symbol: string; n: number }[] } {
  let walls = 0
  const symbols = new Map<string, number>()
  for (const a of items) {
    if (a.kind === 'symbol' && a.symbol) symbols.set(a.symbol, (symbols.get(a.symbol) ?? 0) + 1)
    else if (a.role === 'wand') walls++
  }
  return { walls, symbols: [...symbols].map(([symbol, n]) => ({ symbol, n })) }
}

/**
 * The patch that turns the drawn line `a` into a Wand or back into a plain Linie – the «Art» row
 * of the line editor on the storey stack (Whiteboard · DrawEditor). Geometry stays.
 *
 *   · to a Wand: `role`, the Wand `look` (usePlanDraft · GRUNDRISS_STYLE), solid, no Pfeil and no
 *     Marker, and none of a hose's fields (Typ, Leitung Nr., Trupp anchor). `keepTeilstueck`: lines
 *     hang on its «E», which a quiet switch must not cut – the Abschluss row lets go of them, with
 *     its own question. The caller refuses a line a Trupp is on (unlinking is not undoable here).
 *   · to a Linie: no `role`; the Wand's colour becomes `lineColor`, a colour picked by hand stays;
 *     the width stays.
 *
 * Its Durchgänge let go in the board funnel (carryDoors: the line is no Wand any more), exactly as
 * when the Wand is deleted.
 */
export function wallRolePatch(
  a: BoardAnno, wand: boolean, look: { color: string; width: number }, lineColor: string, keepTeilstueck = false,
): Partial<BoardAnno> {
  if (!wand) return { role: undefined, ...(a.color === look.color ? { color: lineColor } : null) }
  return {
    role: 'wand', color: look.color, width: look.width,
    dashed: undefined, arrow: undefined, arrowStop: undefined, marker: undefined,
    ...(keepTeilstueck ? null : { teilstueck: undefined }),
    content: undefined, lineNo: undefined, truppId: undefined,
  }
}
