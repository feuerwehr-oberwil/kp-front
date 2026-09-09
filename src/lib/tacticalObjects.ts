import type { BoardAnno, BoardDoc, BoardPoint, Drawing, Entity, LngLat } from '../types'
import type { GeorefFit } from './georef'
import { planGroundWidthM, boardSymbolToEntity, entityToBoardSymbol } from './georefTwins'

/**
 * The unified tactical object — ONE record per object, whatever surface it stands on
 * (tmp/design-unified-objects.md, decided 09.09.2026). This retires «being on one side»:
 * an object is simply a thing in the Einsatz, rendered wherever its position is knowable.
 *
 * Two bodies, both in their surface's OWN vocabulary (the units genuinely differ — metres
 * vs. plan-width fractions, LngLat vs. per-floor sheet points — so pretending one
 * coordinate fits both would be a lie the print/render paths pay for):
 *
 *   · `entity` XOR `drawing` — the map body, exactly what the Karte renders.
 *   · `sheet` — the sheet body: which plan, and exactly what that plan renders.
 *
 * ⚠️ THE ANCHOR IS THE SHEET BODY'S PRESENCE. An object hand-placed on a sheet carries
 * `sheet` (sheet coords are its truth; the map body is BAKED through the georef fit and
 * re-baked when the fit changes). An object hand-placed on the Karte carries no `sheet`
 * at all — geo is its truth, and a linked plan shows it by live projection, exactly like
 * the old twins. A drag flips the anchor to the surface it happened on: dragging a sheet
 * object on the Karte DROPS the sheet body (geo becomes truth), dragging a map object on
 * a sheet CREATES one. «Last hand-placement owns the truth.»
 *
 * Reference change/delete loses nothing: a sheet-anchored object keeps its sheet coords
 * AND its last-baked map body; a geo-anchored object keeps geo and merely stops appearing
 * on the unlinked sheet.
 */
export interface TacticalObject {
  id: string
  /** the map body — point-ish kinds (symbol/note/shape/team/photo) */
  entity?: Entity
  /** the map body — path kinds (line/area/circle). Mutually exclusive with `entity`. */
  drawing?: Drawing
  /** the sheet body; its presence makes the object SHEET-anchored */
  sheet?: { planId: string; anno: BoardAnno }
}

/** The three legacy collections, as views — every consumer keeps speaking these shapes. */
export interface ObjectViews {
  entities: Entity[]
  drawings: Drawing[]
  board: BoardDoc
}

/**
 * Phase-1 views: render-identical to the old three collections. A sheet-anchored object
 * materializes ONLY its sheet body (the map shows it through the twin projection, as
 * before); a geo-anchored object materializes only its map body. Phase 2 flips this to
 * «any body renders natively» and deletes the projection machinery.
 */
export function viewsOf(objects: TacticalObject[]): ObjectViews {
  const entities: Entity[] = []
  const drawings: Drawing[] = []
  const board: BoardDoc = {}
  for (const o of objects) {
    if (o.sheet) {
      ;(board[o.sheet.planId] ??= []).push(o.sheet.anno)
    } else if (o.entity) {
      entities.push(o.entity)
    } else if (o.drawing) {
      drawings.push(o.drawing)
    }
  }
  return { entities, drawings, board }
}

/**
 * Lazy migration of a legacy blob's three collections into unified objects. Pure and
 * idempotent-by-construction (a migrated blob has no legacy collections left to migrate).
 *
 * A duplicate id across collections — the old transfer's delete+add could be resurrected
 * on both sides by a concurrent merge — HEALS into one object: the sheet body wins the
 * anchor (it is the more deliberate placement; the map copy becomes its baked body).
 */
export function objectsFromLegacy(
  entities: Entity[] | undefined,
  drawings: Drawing[] | undefined,
  board: BoardDoc | undefined,
): TacticalObject[] {
  const byId = new Map<string, TacticalObject>()
  for (const e of entities ?? []) {
    byId.set(e.id, { id: e.id, entity: e })
  }
  for (const d of drawings ?? []) {
    const dup = byId.get(d.id)
    // an id can never honestly be an entity AND a drawing — keep the first, they were
    // separate collections and the collision is corrupt data, not a healable transfer
    if (!dup) byId.set(d.id, { id: d.id, drawing: d })
  }
  for (const [planId, annos] of Object.entries(board ?? {})) {
    for (const anno of annos) {
      const dup = byId.get(anno.id)
      if (dup) {
        byId.set(anno.id, { ...dup, sheet: { planId, anno } })
      } else {
        byId.set(anno.id, { id: anno.id, sheet: { planId, anno } })
      }
    }
  }
  return [...byId.values()]
}

/** What one linked plan contributes to baking: its fit and the sheet's aspect. */
export interface PlanFit { fit: GeorefFit; aspect: number }

/** A sheet point's x/y without its optional per-point floor. */
const ptXY = (p: BoardPoint): { x: number; y: number } => ({ x: p[0], y: p[1] })

/** Copy exactly the listed keys, and only the ones the source actually carries. */
function pick<T extends object, K extends readonly (keyof T)[]>(o: T, keys: K): Pick<T, K[number]> {
  const out: Partial<T> = {}
  for (const k of keys) if (k in o) out[k] = o[k]
  return out as Pick<T, K[number]>
}

/**
 * THE shared vocabulary of a path object and its sheet anno: the fields both surfaces spell the
 * same way, in ONE list rather than two hand-kept literals — the type only admits a name that
 * really is on both sides. Geometry is deliberately absent: `pts`/`coords` and
 * `radiusN`/`radiusM` are the same statement in two different units, converted by hand below.
 */
const SHARED_PATH_PROPS = [
  'color', 'width', 'dashed', 'arrow', 'arrowStop', 'marker', 'fillOpacity', 'hatch', 'locked',
  'teilstueck', 'content', 'lineNo', 'floorTag', 'showDistance', 'labelDx', 'labelDy',
  'label', 'truppId',
] as const satisfies readonly (keyof Drawing & keyof BoardAnno)[]

/** …and the subset a circle has (it is a point object with an extent — no stroke vocabulary). */
const SHARED_CIRCLE_PROPS = [
  'color', 'fillOpacity', 'hatch', 'locked', 'showDistance',
] as const satisfies readonly (keyof Drawing & keyof BoardAnno)[]

/**
 * Bake the MAP body of one sheet-anchored object through its plan's fit — the write-through
 * half that makes the record self-contained (Kroki and map replay read baked bodies, never
 * a fit). Returns the object unchanged when the anno kind has no map counterpart or no fit is
 * known for its sheet — the latter is honest, not a gap: a plan without a georeference cannot
 * say where on the ground its symbols stand.
 *
 * Vocabulary mapping (the same one the transfer door and the content twins use):
 *   symbol   → Entity 'symbol' (storey → floor, reachN → reachM)
 *   text     → Entity 'note'   (wN is a plan fraction, noteW screen px — width NOT carried)
 *   shape    → Entity 'shape'  (sizeN → sizeM)
 *   resource → Entity 'team'   (the Trupp chip; its plan-space trail becomes a geo trail)
 *   draw     → Drawing 'line'  (pts → coords; FKS annotations ride along)
 *   area     → Drawing 'area'
 *   circle   → Drawing 'circle' (radiusN → radiusM)
 */
export function bakeGeoBody(o: TacticalObject, plan: PlanFit | undefined, layer: Entity['layer']): TacticalObject {
  if (!o.sheet || !plan) return o
  const { anno } = o.sheet
  const widthM = planGroundWidthM(plan.fit, plan.aspect)
  const at = (x: number, y: number): LngLat => { const p = plan.fit.toMap({ x, y }); return [p.lng, p.lat] }
  if (anno.kind === 'symbol' && anno.x != null && anno.y != null) {
    const entity = boardSymbolToEntity(anno, at(anno.x, anno.y), o.entity?.layer ?? layer, widthM)
    return entity ? { ...o, entity, drawing: undefined } : o
  }
  if (anno.kind === 'text' && anno.x != null && anno.y != null) {
    const entity: Entity = {
      id: o.id, kind: 'note', layer: o.entity?.layer ?? layer, coord: at(anno.x, anno.y),
      label: anno.text ?? anno.label, rotation: anno.rotation, color: anno.color,
      noteSize: anno.noteSize, noteAutoW: anno.noteAutoW, notePlain: anno.notePlain,
      floor: anno.storey,
    }
    return { ...o, entity, drawing: undefined }
  }
  if (anno.kind === 'shape' && anno.x != null && anno.y != null && anno.shape) {
    const entity: Entity = {
      id: o.id, kind: 'shape', layer: o.entity?.layer ?? layer, coord: at(anno.x, anno.y),
      shape: anno.shape, rotation: anno.rotation, rotation2: anno.rotation2, color: anno.color,
      sizeM: anno.sizeN != null ? anno.sizeN * widthM : undefined,
      aspect: anno.aspect, stop: anno.stop, carrier: anno.carrier, reverse: anno.reverse,
      strokeW: anno.strokeW, fillOpacity: anno.fillOpacity, hatch: anno.hatch,
      sharpCorners: anno.sharpCorners, locked: anno.locked, floor: anno.storey,
    }
    return { ...o, entity, drawing: undefined }
  }
  if (anno.kind === 'resource' && anno.x != null && anno.y != null) {
    // the Trupp chip is the plan twin of the map's 'team' marker — same object, same id, and
    // the recorded breadcrumbs are part of the incident record, so they cross with it
    const entity: Entity = {
      id: o.id, kind: 'team', layer: o.entity?.layer ?? layer, coord: at(anno.x, anno.y),
      label: anno.text ?? anno.label, color: anno.color, truppId: anno.truppId, t: anno.t,
      trail: anno.trail?.map((p) => ({ coord: at(p.x, p.y), t: p.t })),
    }
    return { ...o, entity, drawing: undefined }
  }
  if ((anno.kind === 'draw' || anno.kind === 'area') && anno.pts?.length) {
    const drawing: Drawing = {
      ...pick(anno, SHARED_PATH_PROPS),
      id: o.id, kind: anno.kind === 'draw' ? 'line' : 'area',
      coords: anno.pts.map((p) => { const { x, y } = ptXY(p); return at(x, y) }),
    }
    return { ...o, drawing, entity: undefined }
  }
  if (anno.kind === 'circle' && anno.x != null && anno.y != null) {
    const drawing: Drawing = {
      ...pick(anno, SHARED_CIRCLE_PROPS),
      id: o.id, kind: 'circle', coords: [at(anno.x, anno.y)],
      radiusM: anno.radiusN != null ? anno.radiusN * widthM : undefined,
    }
    return { ...o, drawing, entity: undefined }
  }
  return o
}

/**
 * Bake the SHEET body of a geo-anchored object onto one plan — the door the «drag onto the
 * sheet» flow uses when it flips the anchor. The symbol path reuses the transfer converter;
 * the caller supplies the drop point in plan space.
 */
export function bakeSheetSymbol(o: TacticalObject, planId: string, pt: { x: number; y: number }, plan: PlanFit): TacticalObject | null {
  if (!o.entity) return null
  const widthM = planGroundWidthM(plan.fit, plan.aspect)
  const anno = entityToBoardSymbol(o.entity, pt, widthM)
  return anno ? { ...o, sheet: { planId, anno } } : null
}

/** Replace one object's sheet anno in place (same plan, same id). */
export function withSheetAnno(o: TacticalObject, anno: BoardAnno): TacticalObject {
  return o.sheet ? { ...o, sheet: { ...o.sheet, anno } } : o
}

/**
 * The setDoc seam: apply a full `{entities, drawings}` document — the shape every existing
 * map mutator produces — onto the unified store. Geo-anchored objects are replaced
 * wholesale by the document; sheet-anchored objects are untouched (the map materializes
 * them through the projection in phase 1, so no map mutator can legitimately hand them
 * back here). A geo-anchored id missing from the document is a deletion — of the whole
 * object, which is exactly what deleting is under one-record semantics.
 */
export function applyDocToObjects(objects: TacticalObject[], doc: { entities: Entity[]; drawings: Drawing[] }): TacticalObject[] {
  const sheetAnchored = objects.filter((o) => o.sheet)
  const next: TacticalObject[] = sheetAnchored.slice()
  const sheetIds = new Set(sheetAnchored.map((o) => o.id))
  for (const e of doc.entities) {
    if (e.live) continue // live overlays are derived, never records
    if (sheetIds.has(e.id)) continue
    next.push({ id: e.id, entity: e })
  }
  for (const d of doc.drawings) {
    if (sheetIds.has(d.id)) continue
    next.push({ id: d.id, drawing: d })
  }
  return next
}

/**
 * The setBoard seam: apply one plan's full anno list — the shape every existing plan
 * mutator produces — onto the unified store. An anno id new to the store becomes a
 * sheet-anchored object; a known one is updated in place (its baked map body is left
 * for the caller's bake to refresh); an id missing from the list is a deletion — again
 * of the whole object.
 *
 * ⚠️ The anno list's ORDER is the sheet's paint order, and the store is what the board view
 * is derived from, so this plan's objects are re-seated into their own slots in exactly the
 * order the list gives. Without that, a «nach vorne» on the sheet would round-trip through
 * the store and come back in the old order. Slots, not an append: the interleaving with the
 * map's own objects — which is the KARTE's paint order — must survive a plan edit untouched.
 */
export function applyBoardToObjects(objects: TacticalObject[], planId: string, annos: BoardAnno[]): TacticalObject[] {
  const ids = new Set(annos.map((a) => a.id))
  const kept = objects.filter((o) => o.sheet?.planId !== planId || ids.has(o.id))
  const byId = new Map(kept.map((o) => [o.id, o]))
  // an object handed to a plan list it was not on — a fresh anno, or the drag-onto-sheet that
  // flips a map object's anchor — takes the sheet as its anchor either way
  const made = annos.map((anno): TacticalObject => {
    const prev = byId.get(anno.id)
    return prev ? { ...prev, sheet: { planId, anno } } : { id: anno.id, sheet: { planId, anno } }
  })
  const next = kept.slice()
  const slots: number[] = []
  next.forEach((o, i) => { if (ids.has(o.id)) slots.push(i) })
  made.forEach((o, i) => { const at = slots[i]; if (at == null) next.push(o); else next[at] = o })
  return next
}

/** Re-derive the map bodies of ONE plan's objects — what a plan mutation owes the Karte. */
export function bakePlan(objects: TacticalObject[], planId: string, plan: PlanFit | undefined, defaultLayer: Entity['layer']): TacticalObject[] {
  return objects.map((o) => (o.sheet?.planId === planId ? bakeGeoBody(o, plan, defaultLayer) : o))
}

/**
 * …and every plan's, for the two moments that owe it wholesale: a store just hydrated from a
 * blob, and a georeference that has just changed (a fit correction MOVES every symbol standing
 * on that sheet — see tmp/design-unified-objects.md · «Reference change»).
 */
export function bakeAll(objects: TacticalObject[], fits: ReadonlyMap<string, PlanFit>, defaultLayer: Entity['layer']): TacticalObject[] {
  return objects.map((o) => (o.sheet ? bakeGeoBody(o, fits.get(o.sheet.planId), defaultLayer) : o))
}
