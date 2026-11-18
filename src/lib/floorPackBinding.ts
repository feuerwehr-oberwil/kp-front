import type { PlanFloor } from './api/reference'
import { floorKey, joinKey, referenceUrl } from './api/reference'
import { effectiveBindingGeoref, type IncidentPlanBinding } from './incidentPlanBindings'
import { fitSimilarity, type GeorefFit } from './georef'
import { pdfPageOf, withPdfPage } from './whiteboard'
import { bandAspect } from './footprint'
import type { BoardAnno, BuildingDoc } from '../types'

/**
 * The active object's floor pack as the Gebäude stack needs it, read from the incident's frozen
 * binding (so a running Einsatz keeps its pages and fit whatever the station publishes later).
 *
 * Every storey tile shows the same FRAME: the reference drawing's rectangle on its page (the fit
 * page's floor 0, else the fit page's first floor). An unjoined whole floor on another page
 * shares that frame as it is – the export convention. A floor that is a REGION of a sheet is
 * shifted into the frame through its JOIN – «my point `at` is floor X's point `there»» (the same
 * staircase on both drawings) – chained floor by floor until the reference is reached, in either
 * direction and across PDF pages; a region nothing joins falls back to its rectangle's top-left corner against the
 * reference's. It is clipped to its own rectangle, so neighbouring drawings never bleed in.
 * All of this is in normalized page coordinates; the pack's ONE map fit speaks the same.
 *
 * A storey may be drawn in SEVERAL pieces (16.09.) – two wings of one 1. OG as two drawings –
 * and then it has several tiles, each with its own rectangle and its own shift. They land in the
 * one frame beside each other; the storey tile shows their union.
 */
export interface FloorPackTile {
  /** the page's URL (`#page=N`, lib/whiteboard · pdfPageOf) */
  url: string
  /** this floor's rectangle on its page, normalized [x0, y0, x1, y1] */
  clip: [number, number, number, number]
  /** page-coordinate shift that lays this drawing onto the reference drawing */
  shift: [number, number]
  /** which drawing of its storey this is (0 = the first / only one) */
  part: number
  /** the drawing's own name, where the pack gives it one («Westflügel») */
  name: string | null
}
export interface FloorPackView {
  floors: PlanFloor[]
  /** by storey index, that storey's drawings in part order – never an empty list */
  tiles: Record<number, FloorPackTile[]>
  /** the reference drawing's rectangle – what a tile shows */
  frame: [number, number, number, number]
  fit: GeorefFit | null
  /** the fitted page's width / height (every page of the pack shares it by convention) */
  aspect: number | null
}

const WHOLE: [number, number, number, number] = [0, 0, 1, 1]

/** How long the frame measurement (`trimmedPackFrame`) may take before a stack is seeded with
 *  the untrimmed frame — offline, or a sheet that will not render, never leaves a Gebäude empty. */
export const PACK_TRIM_MS = 4000

export function floorPackOf(bindings: IncidentPlanBinding[], objectId: string | null | undefined): FloorPackView | null {
  if (!objectId) return null
  const b = bindings.find((x) => x.objectId === objectId && x.floors?.length)
  if (!b?.floors) return null
  const url = referenceUrl(b.datasetId, b.planVersion)
  const pairs = effectiveBindingGeoref(b).pairs
  const onFitPage = b.floors.filter((f) => f.page === b.page)
  // the FRAME is one drawing: level 0's first piece, never a second wing of it
  const first = onFitPage.filter((f) => (f.part ?? 0) === 0)
  const ref = first.find((f) => f.index === 0) ?? first[0] ?? onFitPage[0] ?? b.floors[0]
  const shifts = joinShifts(b.floors, ref)
  const tiles: Record<number, FloorPackTile[]> = {}
  for (const f of [...b.floors].sort((a, c) => (a.part ?? 0) - (c.part ?? 0))) {
    (tiles[f.index] ??= []).push({
      url: withPdfPage(url, f.page), clip: f.clip ?? WHOLE, shift: shifts.get(floorKey(f)) ?? [0, 0],
      part: f.part ?? 0, name: f.name,
    })
  }
  return {
    floors: b.floors, tiles, frame: ref.clip ?? WHOLE,
    fit: pairs.length >= 2 && b.aspect ? fitSimilarity(pairs, b.aspect) : null,
    aspect: b.aspect ?? null,
  }
}

/** Resolve explicit joins first, in either direction and across pages. Disconnected components
 *  retain the legacy page frame (whole page) or corner fallback (crop); their joins still apply.
 *  One point supplies translation only: pages must share normalized scale and orientation.
 *
 *  Keyed by DRAWING (`floorKey`, storey + part): two wings of one storey are two drawings with
 *  two joins, and a shift per storey could only ever place one of them. */
export function joinShifts(floors: PlanFloor[], ref: PlanFloor): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  const rc = ref.clip ?? WHOLE
  const resolve = (seed: PlanFloor, shift: [number, number]) => {
    out.set(floorKey(seed), shift)
    const pending = [seed]
    for (let i = 0; i < pending.length; i++) {
      const current = pending[i]
      const s = out.get(floorKey(current))!
      for (const f of floors) {
        if (out.has(floorKey(f))) continue
        const forward = f.join && joinKey(f.join) === floorKey(current) ? f.join : undefined
        const backward = current.join && joinKey(current.join) === floorKey(f) ? current.join : undefined
        if (!forward && !backward) continue
        const j = (forward ?? backward)!
        const sign = forward ? 1 : -1
        out.set(floorKey(f), [s[0] + sign * (j.there[0] - j.at[0]), s[1] + sign * (j.there[1] - j.at[1])])
        pending.push(f)
      }
    }
  }
  resolve(ref, [0, 0])
  // A whole page is the existing shared-frame convention, so anchor it before orphan crops.
  for (const f of [...floors.filter(f => !f.clip), ...floors.filter(f => f.clip)]) {
    if (out.has(floorKey(f))) continue
    const fc = f.clip ?? WHOLE
    resolve(f, f.clip ? [rc[0] - fc[0], rc[1] - fc[1]] : [0, 0])
  }
  return out
}

/** The stack's storeys, lowest first – one per index however many drawings the storey has: the
 *  Gebäude has one tile per Geschoss, and its wings live inside that tile. */
export const packStoreys = (floors: PlanFloor[]): number[] =>
  [...new Set(floors.map((f) => f.index))].sort((a, b) => a - b)

/** The operator-facing name per storey. A storey drawn in several pieces has a name PER PIECE
 *  («Westflügel»), which is a caption on the drawing and not the name of the Geschoss – so only
 *  a storey drawn once lends its name to the stack's heading. */
export function packFloorNames(floors: PlanFloor[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const index of new Set(floors.map((f) => f.index))) {
    const pieces = floors.filter((f) => f.index === index)
    if (pieces.length === 1 && pieces[0].name) out[String(index)] = pieces[0].name
  }
  return out
}

/** the frame's h/w as the tile box draws it: a region of a landscape page can be taller than wide */
export const frameAspect = (frame: [number, number, number, number], pageAspect: number): number =>
  (frame[3] - frame[1]) / ((frame[2] - frame[0]) * pageAspect)

/**
 * The Gebäude stack a floor pack IS (decided 14.09.2026): no footprint, no outline — the storeys
 * from the pack's pages, each tile showing `frame` (`trimmedPackFrame`), as tall as that frame
 * needs (lib/footprint · bandAspect). The ONE builder of a pack stack: the Einsatz seeds its
 * building from it (useGeorefFits), and «Karte & Objekte» shows an object's floors through it
 * without an Einsatz (review round 4, owner: «gebäude should be literally 1:1 the same as in the
 * normal incident just without editing»). Null without the pack's page aspect (no approved fit
 * and no page size to stand in). Pure.
 */
export function packBuildingDoc(
  view: Pick<FloorPackView, 'floors' | 'aspect'>,
  frame: [number, number, number, number],
  bindingId?: string,
): BuildingDoc | null {
  if (!view.floors.length || !view.aspect) return null
  const ringAspect = frameAspect(frame, view.aspect)
  const names = packFloorNames(view.floors)
  const pack = { bindingId, aspect: view.aspect, ...(frame.some((v, i) => v !== WHOLE[i]) ? { frame } : {}) }
  return {
    ring: [], rings: [], ringAspect, tileAR: bandAspect(ringAspect), pack,
    floors: packStoreys(view.floors),
    ...(Object.keys(names).length ? { floorNames: names } : {}),
  }
}

/** the union of two rectangles, both in the same (page) coordinates */
const union = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]

/**
 * The frame every storey tile shows, trimmed to what the drawings actually USE (16.09.2026).
 *
 * The reference drawing's rectangle is drawn by hand in the admin, so it carries whatever paper
 * margin the person drawing it left – and a shared frame multiplies that margin by the storey
 * count, on the one surface where a storey is already small. `inkOf` measures where the ink stops
 * inside a drawing (components/PdfViewport · regionInkBox); each drawing's ink box is shifted onto
 * the reference the same way its raster is, and the union of them is the frame.
 *
 * ⚠️ UNION, so a wing drawn outside the reference rectangle widens the frame instead of hanging
 * off its tile — which is what it did before.
 * ⚠️ Every failure lands on the drawing's own rectangle, so the worst case is exactly today's
 * frame: offline, a PDF that will not render, a browser that refuses the pixels, an empty region.
 * Computed ONCE, when the stack is created: the frame is what tile coordinates are relative to, so
 * moving it under ink that is already drawn would move the ink with it.
 */
export async function trimmedPackFrame(
  view: Pick<FloorPackView, 'tiles' | 'frame'>,
  inkOf: (url: string, clip: [number, number, number, number]) => Promise<readonly [number, number, number, number] | null>,
): Promise<[number, number, number, number]> {
  const tiles = Object.values(view.tiles).flat()
  if (!tiles.length) return view.frame
  const boxes = await Promise.all(tiles.map(async (t) => {
    const ink = await inkOf(t.url, t.clip).catch(() => null)
    const box = (ink ?? t.clip) as [number, number, number, number]
    return [box[0] + t.shift[0], box[1] + t.shift[1], box[2] + t.shift[0], box[3] + t.shift[1]] as [number, number, number, number]
  }))
  const out = boxes.reduce(union)
  // a degenerate result (a single line of ink, everything blank) is no frame at all
  return out[2] - out[0] > 0.01 && out[3] - out[1] > 0.01 ? out : view.frame
}

/** One storey drawing on a plain sheet that shows a floor pack's page – Modul 6 with its storeys
 *  drawn side by side: the drawing's storey and its rectangle in the sheet's own normalized
 *  coordinates (a plain sheet IS its page). */
export interface SheetDrawing {
  storey: number
  clip: [number, number, number, number]
}

/** The storey drawings the sheet at `imageUrl` shows – the pack's drawings on that sheet's page.
 *  Empty for every other sheet. Any module whose binding carries floors, not only Modul 6. */
export function sheetDrawings(pack: FloorPackView | null | undefined, imageUrl: string): SheetDrawing[] {
  if (!pack || !imageUrl) return []
  const page = withPdfPage(imageUrl, pdfPageOf(imageUrl) ?? 0)
  return Object.entries(pack.tiles).flatMap(([storey, tiles]) =>
    tiles.filter((t) => t.url === page).map((t) => ({ storey: Number(storey), clip: t.clip })))
}

/** the storey of the drawing at (x, y), or null outside every drawing */
export const drawingAt = (drawings: readonly SheetDrawing[], x: number, y: number): number | null =>
  drawings.find(({ clip: [x0, y0, x1, y1] }) => x >= x0 && x <= x1 && y >= y0 && y <= y1)?.storey ?? null

/**
 * A symbol placed or moved on such a sheet takes the storey of the drawing it lands in – what the
 * Gebäude stack does with a storey tile (owner, 18.11.2026: «also auto-change storeys like in
 * gebäude»). `orig` is the symbol as the gesture FOUND it (null for a placement), `moved` the
 * gesture's current frame; the storey is always worked out from `orig`, so a drag that streams
 * frames never shifts a span twice, and one that comes back to its drawing gets its own back.
 *
 * It writes what Von/Bis reads on a plain sheet: `storey` (the Gebäude writes its tile, and the
 * plain sheet's twin of it is the badge – types · BoardAnno.storey), or, for a span, Von and Bis
 * shifted whole by the step between the two drawings, as a span dragged between Gebäude storeys
 * is (stackFloors · normalizeStackEdit). Outside every drawing, and inside the drawing it came
 * from, the storey is the one it had: a storey set by hand within one drawing stays.
 */
export function withDrawingStorey(orig: BoardAnno | null, moved: BoardAnno, drawings: readonly SheetDrawing[]): BoardAnno {
  if (moved.kind !== 'symbol' || !drawings.length || moved.x == null || moved.y == null) return moved
  const to = drawingAt(drawings, moved.x, moved.y)
  const from = orig?.x != null && orig.y != null ? drawingAt(drawings, orig.x, orig.y) : null
  const base = orig ?? moved
  const out: BoardAnno = { ...moved }
  // absent stays absent – never an explicit `undefined` the store would read as a change
  delete out.storey; delete out.floorFrom; delete out.floorTo
  if (to == null || to === from) {
    if (base.storey != null) out.storey = base.storey
    if (base.floorFrom != null) out.floorFrom = base.floorFrom
    if (base.floorTo != null) out.floorTo = base.floorTo
    return out
  }
  if (base.floorFrom == null && base.floorTo == null) return { ...out, storey: to }
  const delta = to - (from ?? base.floorFrom ?? base.floorTo ?? to)
  if (base.floorFrom != null) out.floorFrom = base.floorFrom + delta
  if (base.floorTo != null) out.floorTo = base.floorTo + delta
  return out
}

/** The storey half of a symbol's `board.move` payload, so the Verlauf replay folds it too
 *  (lib/replay · board.move): Von/Bis on the Gebäude stack, and on a sheet with storey drawings
 *  the storey a drawing may have given it. Nothing elsewhere – a move there keeps its storey. */
export const storeyMove = (a: BoardAnno, stack: boolean, drawings: readonly SheetDrawing[]): Partial<BoardAnno> =>
  stack ? { floorFrom: a.floorFrom, floorTo: a.floorTo }
    : drawings.length ? { storey: a.storey, floorFrom: a.floorFrom, floorTo: a.floorTo } : {}
