/** The Karte, mirrored onto a plan sheet — what is left of the «Zwillinge».
 *
 *  Once a plan carries a usable georeference (lib/georef · fitSimilarity, ≥2 pairs), a linked sheet
 *  also shows what stands on the ground around it: the live vehicles, the Lage's own symbols,
 *  drawings, notes and Trupp chips. This module is the whole derivation of that — no state, no
 *  React, no rendering. It answers three questions:
 *
 *    1. at which `planAspect` a plan's fit is taken (the one number `fitSimilarity` needs and
 *       nobody stores explicitly — see `planAspect` below),
 *    2. which map points cross over, and where on the sheet they land,
 *    3. which rows the Ebenen panel shows for them.
 *
 *  ## The other direction is no longer a projection
 *
 *  ⚠️ Plan → Karte used to live here too, as a mirror image of all this. It does not any more:
 *  an object drawn on a sheet is ONE record whose map body is BAKED through this same fit
 *  (lib/tacticalObjects), so the Karte draws it as an ordinary marker — ordinary selection,
 *  ordinary panel, ordinary drag, ordinary undo — instead of as a projection with its own layer,
 *  its own selection list and its own gesture. What is below is the half that is still derived.
 *
 *  ## What a twin is NOT
 *
 *  A twin is a PROJECTION, never an object. It is never written to the workspace document, never
 *  logged to the Verlauf, never feeds a clock or a placement. A twin itself cannot move because
 *  there is nothing to move; a drag on its mark is inverted through the fit and moves the ONE
 *  source object, then every projection follows on the next render. That is also why twins are
 *  hidden during replay: the georeference is station data that was never part of the recorded
 *  incident, and the live vehicle feed is the present tense.
 *
 *  ## The clip
 *
 *  Map → plan is projected with `toPlan`, which is defined for the whole world — a vehicle two
 *  kilometres away comes back as `y = 37.4` and would smear along the sheet edge, or worse, sit
 *  just off it and look like it is «at the building». So everything outside the sheet is DROPPED,
 *  with a small margin (`TWIN_CLIP_MARGIN`) so a hydrant a hair past the paper edge still shows.
 */
import { fitSimilarity, hasAutoPairs, residualClaim, type Georef, type GeorefFit, type PlanPt } from './georef'
import type { PlanScale } from './planScale'
import type { StationPlanScales } from './stationPlanScale'
import type { BoardAnno, Drawing, Entity, LngLat, PlanDocument } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { circlePolygon } from './geo'

/** How far past the sheet edge a projected map object may sit and still be drawn — 2 % of the
 *  sheet. Enough that a hydrant on the kerb outside the plan frame is not lost to a rounding
 *  error; far too little for anything that is genuinely somewhere else. */
export const TWIN_CLIP_MARGIN = 0.02

/** Aspect (width / height) of an A4 sheet in portrait — the same seed the Whiteboard starts a
 *  document at before its bitmap has been measured. */
const A4_PORTRAIT_AR = 1 / 1.414

/**
 * The `planAspect` a plan's georef fit has to be taken at (width / height).
 *
 * ⚠️ Nothing stores this number under its own name, and it MATTERS: the fit is solved in the
 * isotropic space `(x·ar, y)`, so a wrong aspect tilts and stretches every twin. It is recovered
 * in the same priority order `resolvePlanScale` uses, because `PlanScale.ar` IS this number —
 * it is recorded on every calibration precisely so a factor can be called stale when the sheet
 * changes shape:
 *
 *   per-incident calibration → station per-plan override → station default → A4 by orientation.
 *
 * The last step is a fallback, not a measurement: an uncalibrated plan on a device that has not
 * opened it yet is assumed to be the A4 its orientation says it is. For the Modul 2/3 sheets
 * this app is built around that is exactly right; for a plan of some other proportion the twins
 * are approximate until it is calibrated once. The surface that HAS measured the sheet (the
 * Whiteboard, via usePlanMeasure · measureAR) passes its own value instead — see `measured`.
 *
 * ⚠️ Unlike `resolvePlanScale` this canNOT skip a STALE candidate, and the reason is circular:
 * `isStale` asks whether a calibration's `ar` still matches the CURRENT aspect, and the current
 * aspect is the very thing being looked for here. So when a Modul PDF is replaced by a
 * differently-shaped sheet, the old `ar` — the one value staleness exists to reject — is exactly
 * what survives, and every twin of that plan comes out tilted and stretched while the residuals
 * stay near zero (the pairs were fitted at the same wrong aspect, so they cannot disagree with
 * it; see georef · collinear for the same blind spot). `measured` is the only real cure, which is
 * why the Whiteboard passes its own number. The Karte has no bitmap to measure, so its twins ride
 * the stored `ar` until that plan is calibrated once on this device.
 */
export function planAspect(
  plan: Pick<PlanDocument, 'id' | 'orientation'>,
  scales: StationPlanScales,
  workspaceScale?: PlanScale,
  measured?: number,
): number {
  if (measured && measured > 0) return measured
  for (const cand of [workspaceScale, scales.byPlan[plan.id], scales.default ?? undefined]) {
    if (cand && cand.ar > 0) return cand.ar
  }
  return plan.orientation === 'portrait' ? A4_PORTRAIT_AR : 1 / A4_PORTRAIT_AR
}

/** A plan that is actually tied to the map, with its solved transform. */
export interface GeorefPlan {
  id: string
  /** the plan's rail code («Modul 2») — what the Ebenen row is named after */
  code: string
  title: string
  imageUrl?: string
  fit: GeorefFit
  /** ground width of the fitted sheet in metres (planGroundWidthM at the fit's own aspect) —
   *  what turns the sheet's normalized sizes into real distances on the Karte */
  widthM: number
  /** the fit still leans on the automatic scaffolding (georef · hasAutoPairs) — the Ebenen
   *  rows then say «ungemessen» instead of claiming a ⌀ off the contaminated fit */
  auto?: boolean
}

/**
 * Every plan of this incident's object that carries a usable fit, in the order the plans were
 * given (which is the order the rail lists them, so the Ebenen rows read as the rail does).
 *
 * A plan with fewer than two pairs, or one whose pairs sit on top of each other, simply is not
 * in the list — `fitSimilarity` is the single arbiter of «usable», here as everywhere else.
 */
export function georefPlans(
  plans: PlanDocument[],
  georefOf: (planId: string) => Georef | null,
  aspectOf: (plan: PlanDocument) => number,
): GeorefPlan[] {
  const out: GeorefPlan[] = []
  for (const p of plans) {
    // a floor stack is a COLUMN of copies of one footprint — one similarity transform cannot
    // mean anything across it, and the pairing mode refuses to arm on it for the same reason
    if (p.floorStack || p.viewer) continue
    const pairs = georefOf(p.georefKey ?? p.id)?.pairs
    if (!pairs?.length) continue
    const aspect = aspectOf(p)
    const fit = fitSimilarity(pairs, aspect)
    if (fit) out.push({ id: p.id, code: p.code, title: p.title, imageUrl: p.imageUrl, fit, widthM: planGroundWidthM(fit, aspect), auto: hasAutoPairs(pairs) })
  }
  return out
}

/* ⚠️ No twin-specific size bands. Until 30.08. twins wore their own «quieter» px bands — in the
   field that read as «different object», not as «projection». Doctrine: twins are
   presentation-equivalent — the board sizes a twin with its own native rule (Whiteboard · symBase). */

// --- the map → a plan board -----------------------------------------------------------------

/** Is a projected point on the sheet (plus the tolerated margin)? */
export function onSheet(p: PlanPt, margin = TWIN_CLIP_MARGIN): boolean {
  return (
    Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= -margin && p.x <= 1 + margin && p.y >= -margin && p.y <= 1 + margin
  )
}

/** One map object, projected onto a plan sheet. `entity` is the SOURCE, untouched. */
export interface BoardTwin {
  key: string
  kind: 'vehicle' | 'symbol'
  entityId: string
  pt: PlanPt
  entity: Entity
  /** the sheet transform also carries its rotation, needed to express a north-referenced map
   *  heading in the plan's paper-relative frame. */
  fit: GeorefFit
}

/**
 * Project map entities onto one plan, dropping everything that does not land on the sheet.
 *
 * The clip is the whole point (see the module header): `toPlan` happily returns coordinates for
 * the next canton, and a symbol pinned to the paper edge would be a lie in exactly the place an
 * operator most wants to trust the sheet.
 */
export function boardTwins(
  entities: Entity[],
  fit: GeorefFit,
  kind: BoardTwin['kind'],
  margin = TWIN_CLIP_MARGIN,
): BoardTwin[] {
  const out: BoardTwin[] = []
  for (const e of entities) {
    const pt = fit.toPlan({ lng: e.coord[0], lat: e.coord[1] })
    if (!onSheet(pt, margin)) continue
    out.push({ key: `${kind}:${e.id}`, kind, entityId: e.id, pt, entity: e, fit })
  }
  return out
}

// --- the rest of the operational content ----------------------------------------------------

/** The name a mirrored non-symbol object answers to — its own label/text where it has one, else
 *  its kind's tool name (a nameless mirrored line is «Linie», never «Symbol»). Takes both a plan
 *  annotation and a map entity, because a panel may be handed either shape. */
export function contentTwinName(o: { kind?: string; label?: string; text?: string; shape?: string }): string {
  const C = appConfig.copy
  const named = o.label?.trim() || o.text?.trim()
  if (named) return named
  switch (o.kind) {
    case 'text': case 'note': return C.whiteboard.text
    case 'resource': case 'team': return C.whiteboard.team
    case 'shape': return C.shapes.names[o.shape ?? ''] ?? C.shapes.kindLabel
    case 'area': return C.whiteboard.area
    case 'circle': return C.drawingEditor.circle
    case 'draw': return C.whiteboard.line
    default: return C.whiteboard.georef.twinUnnamed
  }
}

/** A map point projected into one linked sheet. These are deliberately separate from
 *  `BoardTwin`, whose renderer is the tactical-symbol-specific interactive twin. */
export interface BoardEntityTwin {
  key: string
  entityId: string
  pt: PlanPt
  entity: Entity
}

export function boardEntityTwins(entities: Entity[], fit: GeorefFit, margin = TWIN_CLIP_MARGIN): BoardEntityTwin[] {
  return entities.flatMap((entity) => {
    const pt = fit.toPlan({ lng: entity.coord[0], lat: entity.coord[1] })
    // A live-person glyph is a ringed disc. Letting its centre sit in the generic 2 % margin
    // while the board clips at the paper edge leaves only a white crescent plus the person's
    // caption — exactly the stray «Trupp marker thing» seen in the field. A phone fix outside
    // this plan is simply outside; it has no editable projection that needs an edge affordance.
    const clipMargin = entity.kind === 'person' ? 0 : margin
    return onSheet(pt, clipMargin) ? [{ key: `content:${entity.id}`, entityId: entity.id, pt, entity }] : []
  })
}

/** Everything the Karte mirrors onto ONE linked sheet, as printable BoardAnnos (30.08.): the
 *  printed Objektplan page must show what the screen's sheet shows, or the Rapport lies about
 *  the Lage. Symbols, drawings, notes, shapes and Trupp chips (with their recorded trails)
 *  cross over; live vehicles and responder positions are moments, not records, and
 *  entityToBoardSymbol drops them by design. Ids are prefixed so a print anno can never
 *  collide with a sheet-native one. */
export function boardTwinAnnosForPrint(plan: GeorefPlan, entities: Entity[], drawings: Drawing[]): BoardAnno[] {
  const out: BoardAnno[] = []
  for (const t of boardTwins(entities.filter((e) => e.kind === 'symbol'), plan.fit, 'symbol')) {
    const a = entityToBoardSymbol(t.entity, t.pt, plan.widthM)
    if (a) out.push({ ...a, id: `twin-${a.id}` })
  }
  for (const d of boardDrawingTwins(drawings, plan.fit)) out.push(d.anno)
  for (const { entity: e, pt } of boardEntityTwins(entities.filter((e) => e.kind === 'note' || e.kind === 'shape' || e.kind === 'team'), plan.fit)) {
    if (e.kind === 'note') {
      out.push({ id: `twin-${e.id}`, kind: 'text', x: pt.x, y: pt.y, text: e.label ?? '', color: e.color, notePlain: e.notePlain, noteSize: e.noteSize })
    } else if (e.kind === 'shape') {
      // same frame change the screen mirror applies: metre width → sheet fraction, glyph
      // rotation carries the fit's turn (GeorefContentBoard renders with exactly these)
      out.push({
        id: `twin-${e.id}`, kind: 'shape', shape: e.shape, x: pt.x, y: pt.y,
        sizeN: (e.sizeM ?? 40) / plan.widthM, aspect: e.aspect,
        rotation: (e.rotation ?? 0) + plan.fit.rotationDeg, color: e.color, stop: e.stop,
      })
    } else {
      out.push({
        id: `twin-${e.id}`, kind: 'resource', x: pt.x, y: pt.y, text: e.label ?? '', color: e.color, t: e.t,
        trail: e.trail?.map(({ coord, t: at }) => { const p = plan.fit.toPlan({ lng: coord[0], lat: coord[1] }); return { x: p.x, y: p.y, t: at } }),
      })
    }
  }
  return out
}

/** A Karte drawing projected into plan-normalized geometry. A ground-radius circle becomes an
 *  area ring because the Plan has no circle primitive; the georeference still preserves its
 *  actual footprint. Shapes whose bounding box intersects the paper survive even when every
 *  original vertex lies just outside (the board clips the SVG at its own edge). */
export interface BoardDrawingTwin {
  key: string
  drawingId: string
  drawing: Drawing
  anno: BoardAnno
}

export function boardDrawingTwins(drawings: Drawing[], fit: GeorefFit, margin = TWIN_CLIP_MARGIN): BoardDrawingTwin[] {
  const out: BoardDrawingTwin[] = []
  for (const drawing of drawings) {
    const source = drawing.kind === 'circle'
      ? circlePolygon(drawing.coords[0], drawing.radiusM ?? 0, 48)[0]?.slice(0, -1).map((p) => p as LngLat) ?? []
      : drawing.coords
    const pts = source.map(([lng, lat]) => {
      const p = fit.toPlan({ lng, lat })
      return [p.x, p.y] as [number, number]
    })
    if (pts.length < (drawing.kind === 'line' ? 2 : 3)) continue
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    if (Math.max(...xs) < -margin || Math.min(...xs) > 1 + margin || Math.max(...ys) < -margin || Math.min(...ys) > 1 + margin) continue
    const kind: BoardAnno['kind'] = drawing.kind === 'line' ? 'draw' : 'area'
    const mid = pts[Math.floor((pts.length - 1) / 2)]
    const labelAt = drawing.labelAt ? fit.toPlan({ lng: drawing.labelAt[0], lat: drawing.labelAt[1] }) : null
    // The FKS end tag's dragged anchor crosses over the same way the label's does: as an offset
    // from the default spot (72 % along the last segment — the one rule both surfaces draw with),
    // so the tag sits where the operator moved it clear of other symbols.
    const n = pts.length
    const tagBase = kind === 'draw' && n >= 2
      ? [pts[n - 2][0] + (pts[n - 1][0] - pts[n - 2][0]) * 0.72, pts[n - 2][1] + (pts[n - 1][1] - pts[n - 2][1]) * 0.72]
      : null
    const endAt = drawing.endLabelAt ? fit.toPlan({ lng: drawing.endLabelAt[0], lat: drawing.endLabelAt[1] }) : null
    out.push({
      key: `drawing:${drawing.id}`,
      drawingId: drawing.id,
      drawing,
      anno: {
        id: `twin-map-${drawing.id}`, kind, pts,
        color: drawing.color, width: drawing.width, dashed: drawing.dashed,
        arrow: drawing.arrow, arrowStop: drawing.arrowStop, marker: drawing.marker, showDistance: drawing.showDistance,
        label: drawing.label, fillOpacity: drawing.fillOpacity,
        // ⚠️ Schraffur crosses too. It is FKS MEANING, not decoration — a «betroffene Fläche»
        // mirrored as an ordinary washed one says something else about the ground (01.09.).
        hatch: drawing.hatch,
        labelDx: labelAt && mid ? labelAt.x - mid[0] : undefined,
        labelDy: labelAt && mid ? labelAt.y - mid[1] : undefined,
        endDx: endAt && tagBase ? endAt.x - tagBase[0] : undefined,
        endDy: endAt && tagBase ? endAt.y - tagBase[1] : undefined,
        teilstueck: drawing.teilstueck, content: drawing.content, lineNo: drawing.lineNo,
        floorTag: drawing.floorTag, truppId: drawing.truppId,
        // ⚠️ The lock crosses too. Without it a Fläche locked on the Karte was still draggable
        // through its mirror on the Plan, which defeats the whole point of locking it (01.09.).
        locked: drawing.locked,
      },
    })
  }
  return out
}

// --- ownership transfer between the two surfaces ----------------------------------------------
//
// ⚠️ These two functions are a TYPE BOUNDARY, and a spread cannot police one on its own: excess-
// property checking does not apply to spread members, so a field added to `Entity` or `BoardAnno`
// would ride across silently and mean nothing (or the wrong thing) on the far side — a plan-space
// `sizeN` landing on the map, a floor-stack tile index read as a storey badge. So the fields that
// must NOT cross are listed by name, and the two `_…Accounted` assertions below check what is
// LEFT against the target's own keys: add a field to either interface and this file stops
// compiling until somebody has said which side of the boundary it belongs on.

type Assert<T extends true> = T

/** Drop the listed keys. Typed, so the result is exactly `Omit<T, K[number]>` and the assertions
 *  below have something real to measure. */
function omit<T extends object, K extends readonly (keyof T)[]>(o: T, keys: K): Omit<T, K[number]> {
  // `Partial<T>` only so `delete` is legal on the required keys; the return type is the real one.
  const out: Partial<T> = { ...o }
  for (const k of keys) delete out[k]
  return out as Omit<T, K[number]>
}

/** Entity fields that mean nothing — or something else — on a plan sheet: the map's own position
 *  and layer, the live-feed extras, the metre-scaled geometry whose plan twins are `sizeN`/`reachN`,
 *  and the trail/Trupp link that belongs to the ONE surface the object is placed on. `kind` is
 *  re-stated by the transfer and `floor` (the signed storey badge) becomes the plan's `storey`. */
const ENTITY_MAP_ONLY = [
  'coord', 'layer', 'kind', 'symbolSvg', 'badge', 'photoUrl', 'live', 'directed', 'noteW',
  'sizeM', 'reachM', 'truppId', 'trail', 't', 'floor',
] as const satisfies readonly (keyof Entity)[]
type _EntityKeysAccounted = Assert<Exclude<keyof Entity, (typeof ENTITY_MAP_ONLY)[number]> extends keyof BoardAnno ? true : false>

/** BoardAnno fields that do not belong on the map: every non-symbol geometry (draw/area/text/FKS
 *  line annotations), the plan-normalized sizes, and the two floor fields — `floor` is a
 *  floor-stack TILE INDEX that must never be read as `Entity.floor`'s signed badge, while `storey`
 *  is the badge and becomes exactly that. */
const BOARD_PLAN_ONLY = [
  'kind', 'pts', 'x', 'y', 'text', 'wN', 'sizeN', 'reachN', 'radiusN', 'width', 'dashed', 'arrow', 'arrowStop', 'marker',
  'showDistance', 'labelDx', 'labelDy', 'teilstueck', 'content', 'lineNo', 'floorTag',
  'endDx', 'endDy', 'fillOpacity', 'hatch', 't', 'trail', 'truppId', 'floor', 'locked',
  'startAttachment', 'endAttachment', 'storey',
] as const satisfies readonly (keyof BoardAnno)[]
type _BoardKeysAccounted = Assert<Exclude<keyof BoardAnno, (typeof BOARD_PLAN_ONLY)[number]> extends keyof Entity ? true : false>

/** Ground width of the fitted sheet in metres — the one factor that converts the map's
 *  metre-scaled geometry (`reachM`) into plan-width fractions (`reachN`) and back. PlanScale /
 *  georef units are aspect-corrected: one normalized sheet width is ar·mPerU metres. */
export const planGroundWidthM = (fit: GeorefFit, aspect: number) => Math.max(0.001, fit.scaleMPerU * aspect)

/** Move the one source object from Lage ownership to a Modul document. Projection is not copied:
 *  the same id and SymbolProps cross the boundary, then the georeference derives its map twin.
 *  `widthM` (planGroundWidthM) converts the Hubretter reach into the sheet's own unit — without
 *  it the metre value is dropped rather than smuggled across as a wrong number. */
export function entityToBoardSymbol(entity: Entity, pt: PlanPt, widthM?: number): BoardAnno | null {
  if (entity.kind !== 'symbol' || entity.live) return null
  const reachN = entity.reachM != null && widthM ? entity.reachM / widthM : undefined
  return { ...omit(entity, ENTITY_MAP_ONLY), id: entity.id, kind: 'symbol', x: pt.x, y: pt.y, storey: entity.floor, ...(reachN != null ? { reachN } : null) }
}

/** The shared half of a map body: everything that is NOT map-only vocabulary, which by the
 *  `_EntityKeysAccounted` assertion above is exactly a subset of `BoardAnno`'s own fields.
 *  This is what an edit made on the Karte writes through onto a sheet-anchored object's anno
 *  (lib/tacticalObjects · applyDocToObjects). The position and the unit-bearing sizes are
 *  excluded by the same list — neither means anything on a sheet without the plan's fit. */
export function entitySharedProps(entity: Entity): Omit<Entity, (typeof ENTITY_MAP_ONLY)[number]> {
  return omit(entity, ENTITY_MAP_ONLY)
}

/** The reverse ownership transfer. Map-only location/layer fields are supplied by the caller;
 *  no duplicate survives on the plan. */
export function boardSymbolToEntity(anno: BoardAnno, coord: LngLat, layer: Entity['layer'], widthM?: number): Entity | null {
  if (anno.kind !== 'symbol') return null
  const reachM = anno.reachN != null && widthM ? anno.reachN * widthM : undefined
  return { ...omit(anno, BOARD_PLAN_ONLY), id: anno.id, kind: 'symbol', layer, coord, floor: anno.storey, ...(reachM != null ? { reachM } : null) }
}

// --- the Ebenen rows -------------------------------------------------------------------------

/** Ebenen row ids for the twin layers. Prefixed so `toggleLayer` can tell a twin row from a real
 *  `LayerDef` at a glance — the two persist in different places (see IncidentWorkspace). */
export const TWIN_PLAN_IMAGE_PREFIX = 'twin:plan-image:'
export const TWIN_MAP_VEHICLES = 'twin:map:fahrzeuge'
export const TWIN_MAP_SYMBOLS = 'twin:map:symbole'

/** The Ebenen row id for one georeferenced plan's sheet, rastered under the Karte's ink. */
export const twinPlanImageLayerId = (planId: string) => `${TWIN_PLAN_IMAGE_PREFIX}${planId}`

/** Is this an Ebenen row id belonging to a twin layer (rather than a real map `LayerDef`)? */
export const isTwinLayerId = (id: string) => id.startsWith('twin:')

/** A twin's Ebenen row. Shaped like `LayerDef` on purpose — the panel renders both with the
 *  same row markup, so a twin layer is switched exactly like any other layer. */
export interface TwinLayerRow {
  id: string
  group: string
  label: string
  /** the second, quieter line: the fit this row mirrors through */
  sub?: string
  icon: string
  visible: boolean
  /** Raster backdrops expose the same transparency control as every other map overlay. */
  opacity?: number
}

/** Twin layers default ON: a georeference exists because somebody deliberately made one, and
 *  the whole point of making it was to see both pictures at once. */
export function twinVisible(prefs: Record<string, boolean> | undefined, id: string): boolean {
  return prefs?.[id] ?? true
}

/** An explicit «zeigen» jump outranks a stale hidden preference for exactly its destination.
 *  Preserve object identity when nothing changes so a jump to an already visible twin does not
 *  write preferences or re-render every projection. */
export function revealTwinLayer(prefs: Record<string, boolean>, id: string): Record<string, boolean> {
  return twinVisible(prefs, id) ? prefs : { ...prefs, [id]: true }
}

/** The literal sheet is opt-in: symbols are useful by default, a full plan backdrop is not. */
export function twinPlanImageVisible(prefs: Record<string, boolean> | undefined, planId: string): boolean {
  return prefs?.[twinPlanImageLayerId(planId)] ?? false
}

/** How well this plan sits, in the same words the Passung chip uses — «aus 2 Punkten» when the
 *  fit is exact and therefore UNMEASURED, a residual once a third pair has measured it. */
export function twinFitNote(fit: GeorefFit, auto = false): string {
  const C = appConfig.copy.whiteboard.georef
  // an automatic scaffolding in the fit voids every claim: no ⌀ (the synthetic pairs
  // contaminate the number) and no «aus 2 Punkten» (nobody set them) — the row says what it
  // is, exactly as the chip/lamp/Passung do
  if (auto) return C.chipAuto
  const m = residualClaim(fit)
  return m == null ? C.chipTwoPoints : fillTemplate(C.chipResidual, { m: m.toFixed(2) })
}

/** The Karte side: the literal sheet, as an optional raster backdrop under the ink. The symbols
 *  that stand on it need no row of their own any more — they are ordinary map objects and answer
 *  to the Ebene they were placed on. */
export function planRasterRows(
  plans: GeorefPlan[],
  prefs: Record<string, boolean> | undefined,
  opacity: Record<string, number> | undefined = undefined,
): TwinLayerRow[] {
  const C = appConfig.copy.whiteboard.georef
  return plans.flatMap((p) => (p.imageUrl ? [{
    id: twinPlanImageLayerId(p.id),
    group: C.layerGroupPlans,
    label: fillTemplate(C.layerPlanImage, { plan: p.code }),
    sub: twinFitNote(p.fit, p.auto),
    icon: 'map',
    visible: twinPlanImageVisible(prefs, p.id),
    opacity: opacity?.[twinPlanImageLayerId(p.id)] ?? 55,
  }] : []))
}

/** The Plan side: live vehicles plus the Karte's operational markings (symbols, drawings,
 *  notes, shapes, Atemschutz markers and positions). Empty when the sheet has no fit. */
export function mapTwinRows(fit: GeorefFit | null, prefs: Record<string, boolean> | undefined, auto = false): TwinLayerRow[] {
  if (!fit) return []
  const C = appConfig.copy.whiteboard.georef
  const sub = twinFitNote(fit, auto)
  return [
    { id: TWIN_MAP_VEHICLES, group: C.layerGroupMap, label: C.layerMapVehicles, sub, icon: 'truck', visible: twinVisible(prefs, TWIN_MAP_VEHICLES) },
    { id: TWIN_MAP_SYMBOLS, group: C.layerGroupMap, label: C.layerMapSymbols, sub, icon: 'hex', visible: twinVisible(prefs, TWIN_MAP_SYMBOLS) },
  ]
}
