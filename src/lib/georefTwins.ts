/** Automatic map ⇄ plan mirroring — the «Zwillinge».
 *
 *  Once a plan carries a usable georeference (lib/georef · fitSimilarity, ≥2 pairs), the two
 *  surfaces stop being separate pictures: operational annotations on either surface also have a
 *  derived place on the other. This module is
 *  the whole derivation of that — no state, no React, no rendering. It answers three questions:
 *
 *    1. at which `planAspect` is a plan's fit taken (the one number `fitSimilarity` needs and
 *       nobody stores explicitly — see `planAspect` below),
 *    2. which points cross over, and where they land,
 *    3. which rows the Ebenen panel shows for them.
 *
 *  ## What a twin is NOT
 *
 *  A twin is a PROJECTION, never an object. It is never written to the workspace document, never
 *  logged to the Verlauf, never feeds a clock or a placement, and never prints — the Kroki
 *  payload and the plan pages are built from `entities` / `board` alone, which this module only
 *  ever reads. A twin itself still cannot move because there is nothing to move; a drag on its
 *  mark is inverted through the fit and moves the ONE source object, then every projection follows
 *  on the next render. That is also why twins are hidden during replay: the georeference is station data
 *  that was never part of the recorded incident, and the live vehicle feed is the present tense.
 *
 *  ## The clip
 *
 *  Map → plan is projected with `toPlan`, which is defined for the whole world — a vehicle two
 *  kilometres away comes back as `y = 37.4` and would smear along the sheet edge, or worse, sit
 *  just off it and look like it is «at the building». So everything outside the sheet is DROPPED,
 *  with a small margin (`TWIN_CLIP_MARGIN`) so a hydrant a hair past the paper edge still shows.
 *  Plan → map needs no clip: a plan point is on the sheet by definition.
 */
import { fitSimilarity, residualClaim, type Georef, type GeorefFit, type PlanPt } from './georef'
import type { PlanScale } from './planScale'
import type { StationPlanScales } from './stationPlanScale'
import type { BoardAnno, Drawing, Entity, LngLat, PlanDocument } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { circlePolygon } from './geo'
import { circleRingN } from './planScale'

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
    if (fit) out.push({ id: p.id, code: p.code, title: p.title, imageUrl: p.imageUrl, fit, widthM: planGroundWidthM(fit, aspect) })
  }
  return out
}

// --- plan symbols → the Lage map ------------------------------------------------------------

/** One plan symbol, projected onto the map. `anno` is the SOURCE annotation, untouched — the
 *  renderer reads its glyph/rotation/count from there, and the jump target is `planId`+`annoId`. */
export interface MapTwin {
  key: string
  planId: string
  planCode: string
  annoId: string
  coord: LngLat
  anno: BoardAnno
  /** inverse transform used when the projected mark is dragged on the Karte: the source
   *  annotation moves in plan space, then every projection follows from that one write. */
  fit: GeorefFit
}

/**
 * The tactical symbols of every georeferenced plan, on the map.
 *
 * Tactical symbols only: they keep their existing interactive projection path. Other operational
 * content is projected by `mapContentTwins` and rendered by GeorefContentMap, whose hit targets
 * and whole-object drags likewise write the one source annotation.
 */
export function mapTwins(plans: GeorefPlan[], board: Record<string, BoardAnno[] | undefined>): MapTwin[] {
  const out: MapTwin[] = []
  for (const plan of plans) {
    for (const a of board[plan.id] ?? []) {
      if (a.kind !== 'symbol' || a.x == null || a.y == null) continue
      const { lng, lat } = plan.fit.toMap({ x: a.x, y: a.y })
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      out.push({ key: `${plan.id}:${a.id}`, planId: plan.id, planCode: plan.code, annoId: a.id, coord: [lng, lat], anno: a, fit: plan.fit })
    }
  }
  return out
}

/* ⚠️ No twin-specific size bands. Until 30.08. twins wore their own «quieter» px bands
   (map: 15–28 footprint-scaled, board: fixed 28) — in the field that read as «different
   object», not as «projection». Doctrine: twins are presentation-equivalent — each surface
   sizes a twin with its own native rule (map: mapView · symPx, board: Whiteboard · symBase). */

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

/** A non-symbol Plan annotation projected onto the Karte. Point annotations carry `coord`,
 *  path annotations carry `coords`; the source remains the untouched `anno`. */
export interface MapContentTwin {
  key: string
  planId: string
  planCode: string
  annoId: string
  anno: BoardAnno
  fit: GeorefFit
  coord?: LngLat
  coords?: LngLat[]
}

/** Plan → Karte projections for lines, areas, cordons, notes, shapes and Atemschutz resource
 *  markers. Tactical symbols stay in `mapTwins`, where their existing selection/move behavior
 *  lives.
 *
 *  An Absperrkreis crosses as BOTH: its centre (`coord` — it is a point object, and that is what
 *  a whole-object drag writes back) and a projected ring (`coords`), because the Karte can only
 *  paint a circle of PLAN radius as a polygon. The mirror image of what the other direction has
 *  always done with a map circle (boardDrawingTwins). */
export function mapContentTwins(
  plans: GeorefPlan[],
  board: Record<string, BoardAnno[] | undefined>,
): MapContentTwin[] {
  const out: MapContentTwin[] = []
  for (const plan of plans) {
    for (const anno of board[plan.id] ?? []) {
      if (anno.kind === 'symbol') continue
      const base = { key: `${plan.id}:${anno.id}`, planId: plan.id, planCode: plan.code, annoId: anno.id, anno, fit: plan.fit }
      if ((anno.kind === 'draw' || anno.kind === 'area') && anno.pts?.length) {
        const coords = anno.pts.map(([x, y]) => {
          const p = plan.fit.toMap({ x, y })
          return [p.lng, p.lat] as LngLat
        }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
        const min = anno.kind === 'area' ? 3 : 2
        if (coords.length >= min) out.push({ ...base, coords })
        continue
      }
      if (anno.kind === 'circle' && anno.x != null && anno.y != null && (anno.radiusN ?? 0) > 0) {
        // the sheet's aspect, back out of the two numbers the fit already carries
        // (planGroundWidthM = scaleMPerU · aspect) — the ring is round in PLAN pixels, so it
        // needs the same aspect correction every plan length does (lib/planScale)
        const ar = plan.fit.scaleMPerU > 0 ? plan.widthM / plan.fit.scaleMPerU : 1
        const c = plan.fit.toMap({ x: anno.x, y: anno.y })
        const ring = circleRingN(anno.x, anno.y, anno.radiusN ?? 0, ar).map(([x, y]) => {
          const p = plan.fit.toMap({ x, y })
          return [p.lng, p.lat] as LngLat
        }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
        if (Number.isFinite(c.lng) && Number.isFinite(c.lat) && ring.length >= 3) {
          out.push({ ...base, coord: [c.lng, c.lat], coords: ring })
        }
        continue
      }
      if ((anno.kind === 'text' || anno.kind === 'shape' || anno.kind === 'resource') && anno.x != null && anno.y != null) {
        const p = plan.fit.toMap({ x: anno.x, y: anno.y })
        if (Number.isFinite(p.lng) && Number.isFinite(p.lat)) out.push({ ...base, coord: [p.lng, p.lat] })
      }
    }
  }
  return out
}

/** Whole-object translation of a mirrored path (a projected Plan line or area dragged on the
 *  Karte): every vertex moves by the same plan-space delta. The DELTA — not each vertex — is
 *  clamped to the sheet, because clamping vertices one by one would squash the shape against
 *  the paper edge instead of stopping it there. Vertex-level editing stays with the source.
 *  Generic over the vertex tuple so a `BoardPoint`'s optional per-point floor rides along
 *  untouched — a drag moves the line on the paper, never between storeys. */
export function movedTwinPath<P extends readonly [number, number, ...rest: number[]]>(pts: readonly P[], from: PlanPt, to: PlanPt): P[] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), to.x - from.x))
  const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), to.y - from.y))
  return pts.map((p) => { const [x, y, ...rest] = p; return [x + dx, y + dy, ...rest] as unknown as P })
}

/** The name a mirrored non-symbol object answers to — its own label/text where it has one, else
 *  its kind's tool name (a nameless mirrored line is «Linie», never «Symbol»). Takes both a plan
 *  annotation and a map entity, because the same panels serve both directions of the mirror. */
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
export const TWIN_PLAN_PREFIX = 'twin:plan:'
export const TWIN_PLAN_IMAGE_PREFIX = 'twin:plan-image:'
export const TWIN_MAP_VEHICLES = 'twin:map:fahrzeuge'
export const TWIN_MAP_SYMBOLS = 'twin:map:symbole'

/** The Ebenen row id for one georeferenced plan's symbols on the map. */
export const twinPlanLayerId = (planId: string) => `${TWIN_PLAN_PREFIX}${planId}`
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
export function twinFitNote(fit: GeorefFit): string {
  const C = appConfig.copy.whiteboard.georef
  const m = residualClaim(fit)
  return m == null ? C.chipTwoPoints : fillTemplate(C.chipResidual, { m: m.toFixed(2) })
}

/** The Karte side: one content row per georeferenced plan, plus its optional raster backdrop. */
export function planTwinRows(
  plans: GeorefPlan[],
  prefs: Record<string, boolean> | undefined,
  opacity: Record<string, number> | undefined = undefined,
): TwinLayerRow[] {
  const C = appConfig.copy.whiteboard.georef
  return plans.flatMap((p) => [
    {
      id: twinPlanLayerId(p.id),
      group: C.layerGroupPlans,
      label: fillTemplate(C.layerPlanSymbols, { plan: p.code }),
      sub: twinFitNote(p.fit),
      icon: 'doc',
      visible: twinVisible(prefs, twinPlanLayerId(p.id)),
    },
    ...(p.imageUrl ? [{
      id: twinPlanImageLayerId(p.id),
      group: C.layerGroupPlans,
      label: fillTemplate(C.layerPlanImage, { plan: p.code }),
      sub: twinFitNote(p.fit),
      icon: 'map',
      visible: twinPlanImageVisible(prefs, p.id),
      opacity: opacity?.[twinPlanImageLayerId(p.id)] ?? 55,
    }] : []),
  ])
}

/** The Plan side: live vehicles plus the Karte's operational markings (symbols, drawings,
 *  notes, shapes, Atemschutz markers and positions). Empty when the sheet has no fit. */
export function mapTwinRows(fit: GeorefFit | null, prefs: Record<string, boolean> | undefined): TwinLayerRow[] {
  if (!fit) return []
  const C = appConfig.copy.whiteboard.georef
  const sub = twinFitNote(fit)
  return [
    { id: TWIN_MAP_VEHICLES, group: C.layerGroupMap, label: C.layerMapVehicles, sub, icon: 'truck', visible: twinVisible(prefs, TWIN_MAP_VEHICLES) },
    { id: TWIN_MAP_SYMBOLS, group: C.layerGroupMap, label: C.layerMapSymbols, sub, icon: 'hex', visible: twinVisible(prefs, TWIN_MAP_SYMBOLS) },
  ]
}
