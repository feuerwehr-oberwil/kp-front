import type { BoardAnno, BoardDoc, BoardPoint, Drawing, Entity, LngLat } from '../types'
import type { GeorefFit } from './georef'
import { planGroundWidthM, boardSymbolToEntity, entityToBoardSymbol, entitySharedProps } from './georefTwins'

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
 * The views every surface renders.
 *
 * `entities`/`drawings` are THE Karte, and they now carry the BAKED map body of every
 * sheet-anchored object alongside the geo-anchored ones. A plan-drawn symbol is an ordinary
 * marker on the map — ordinary selection, ordinary panel, ordinary drag, ordinary undo — and
 * that is what retired the plan→Karte twin projection with its own layers, its own selection
 * list, its own drag gesture and its own panels.
 *
 * `board` stays ANCHOR-ONLY: a sheet draws its own annos natively and everything else by the
 * live map→plan projection, which is still the twin machinery (that direction is the next
 * step; see tmp/design-unified-objects.md · phasing).
 *
 * ⚠️ Order is deliberate and stable: geo-anchored first, baked after, each in store order.
 * The later half paints over the earlier one, so a symbol drawn on the Modul sheet is never
 * hidden under the Karte's own work.
 */
export function viewsOf(objects: TacticalObject[]): ObjectViews {
  const entities: Entity[] = []
  const drawings: Drawing[] = []
  const board: BoardDoc = {}
  const baked: TacticalObject[] = []
  for (const o of objects) {
    if (o.sheet) {
      ;(board[o.sheet.planId] ??= []).push(o.sheet.anno)
      // no fit for its plan → no baked body → honestly absent from the Karte
      if (o.entity || o.drawing) baked.push(o)
    } else if (o.entity) {
      entities.push(o.entity)
    } else if (o.drawing) {
      drawings.push(o.drawing)
    }
  }
  for (const o of baked) {
    if (o.entity) entities.push(o.entity)
    else if (o.drawing) drawings.push(o.drawing)
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
    // ⚠️ A live overlay is derived, never a record — the same invariant `applyDocToObjects`
    // enforces at the other seam, so «is it in the store» is a question with one answer
    // wherever it is asked (lib/placedTrupps reads the anchor and relies on exactly this).
    if (e.live) continue
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

/**
 * The ids anchored on ONE sheet — what that sheet draws NATIVELY, and therefore exactly what the
 * still-projected map→plan mirror must not lend it back.
 *
 * ⚠️ Since the Karte draws a sheet-anchored object itself, that object is an ordinary member of
 * `entities`/`drawings`, and a mirror that reads those lists would hand it straight back to the
 * sheet it is drawn on: the symbol appeared twice on its own Modul — once as its anno, once as a
 * twin of its own baked body — and printed twice.
 */
export function sheetAnchoredIds(objects: TacticalObject[], planId: string): Set<string> {
  const out = new Set<string>()
  for (const o of objects) if (o.sheet?.planId === planId) out.add(o.id)
  return out
}

/** What one linked plan contributes to baking: its fit and the sheet's aspect. */
export interface PlanFit { fit: GeorefFit; aspect: number }

/** A sheet point's x/y without its optional per-point floor. */
const ptXY = (p: BoardPoint): { x: number; y: number } => ({ x: p[0], y: p[1] })

/**
 * ⚠️ Is this derived body the one the record already carries? Structural, `undefined`-blind
 * (a missing key and an explicit `undefined` are the same absence), and the reason the bake can
 * run as often as it likes: a re-derivation that changes nothing must return the SAME references,
 * or every hydrate would mark the store dirty and two open devices would push each other in a
 * loop over a picture neither of them changed.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const own = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined)
  const ka = own(a), kb = own(b)
  return ka.length === kb.length
    && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Copy exactly the listed keys, and only the ones the source actually carries. */
function pick<T extends object, K extends readonly (keyof T)[]>(o: T, keys: K): Pick<T, K[number]> {
  const out: Partial<T> = {}
  for (const k of keys) if (k in o) out[k] = o[k]
  return out as Pick<T, K[number]>
}

/**
 * ⚠️ THE shared vocabulary of a path object and its sheet anno: the fields both surfaces spell
 * the same way, in ONE list rather than two hand-kept literals — read by the bake (anno → map
 * body) and written back by the map write-through (annoAfterMapEdit), so an edit made on either
 * surface survives the other's derivation. A name missing here that the bake nonetheless copied
 * would be silently reverted on the next bake; the type only admits names that are on both sides.
 *
 * Geometry is deliberately absent: `pts`/`coords` and `radiusN`/`radiusM` ARE the position, and
 * a position edit on the Karte flips the anchor rather than crossing.
 */
const SHARED_PATH_PROPS = [
  'color', 'width', 'dashed', 'arrow', 'arrowStop', 'marker', 'fillOpacity', 'hatch', 'locked',
  'teilstueck', 'content', 'lineNo', 'floorTag', 'showDistance', 'labelDx', 'labelDy',
  'label', 'truppId',
] as const satisfies readonly (keyof Drawing & keyof BoardAnno)[]

/**
 * ⚠️ Map-only PRESENTATION the bake must not throw away.
 *
 * A baked body is derived, so re-deriving it replaces it — and everything the sheet has no word
 * for went with it every time: a note's dragged width, a Leitung's label and end-tag anchors
 * (georeferenced on the Karte, a board-relative nudge on the sheet), an Abschnitt's Leiter and
 * Auftrag, and a magnetic endpoint's relationship intent. These are the map's own answers to
 * questions the plan never asked; the derived geometry and the shared props still win, these
 * merely survive.
 */
const BAKE_PRESERVED = [
  'noteW', 'labelAt', 'endLabelAt', 'endDx', 'endDy',
  'abschnittLeiter', 'abschnittAuftrag', 'startAttachment', 'endAttachment',
] as const satisfies readonly (keyof Entity | keyof Drawing)[]

/** …the subset of that list one body actually carries (an Entity has no `labelAt`, and so on). */
function preservedFrom<T extends object>(body: T | undefined): Partial<T> {
  if (!body) return {}
  const out: Partial<T> = {}
  for (const k of BAKE_PRESERVED) if (k in body) out[k as keyof T] = body[k as keyof T]
  return out
}

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
  /** The one exit: swap the map body in — or hand the record straight back when the derivation
   *  landed on exactly what it already had. See `sameValue` for why identity matters here. */
  const settle = (body: { entity?: Entity; drawing?: Drawing }): TacticalObject => {
    if (body.entity) {
      const entity = { ...body.entity, ...preservedFrom(o.entity) }
      return !o.drawing && sameValue(o.entity, entity) ? o : { ...o, entity, drawing: undefined }
    }
    if (body.drawing) {
      const drawing = { ...body.drawing, ...preservedFrom(o.drawing) }
      return !o.entity && sameValue(o.drawing, drawing) ? o : { ...o, drawing, entity: undefined }
    }
    return o
  }
  const widthM = planGroundWidthM(plan.fit, plan.aspect)
  const at = (x: number, y: number): LngLat => { const p = plan.fit.toMap({ x, y }); return [p.lng, p.lat] }
  if (anno.kind === 'symbol' && anno.x != null && anno.y != null) {
    const entity = boardSymbolToEntity(anno, at(anno.x, anno.y), o.entity?.layer ?? layer, widthM)
    return entity ? settle({ entity }) : o
  }
  if (anno.kind === 'text' && anno.x != null && anno.y != null) {
    const entity: Entity = {
      id: o.id, kind: 'note', layer: o.entity?.layer ?? layer, coord: at(anno.x, anno.y),
      label: anno.text ?? anno.label, rotation: anno.rotation, color: anno.color,
      noteSize: anno.noteSize, noteAutoW: anno.noteAutoW, notePlain: anno.notePlain,
      floor: anno.storey,
    }
    return settle({ entity })
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
    return settle({ entity })
  }
  if (anno.kind === 'resource' && anno.x != null && anno.y != null) {
    // the Trupp chip is the plan twin of the map's 'team' marker — same object, same id, and
    // the recorded breadcrumbs are part of the incident record, so they cross with it
    const entity: Entity = {
      id: o.id, kind: 'team', layer: o.entity?.layer ?? layer, coord: at(anno.x, anno.y),
      label: anno.text ?? anno.label, color: anno.color, truppId: anno.truppId, t: anno.t,
      trail: anno.trail?.map((p) => ({ coord: at(p.x, p.y), t: p.t })),
    }
    return settle({ entity })
  }
  if ((anno.kind === 'draw' || anno.kind === 'area') && anno.pts?.length) {
    const drawing: Drawing = {
      ...pick(anno, SHARED_PATH_PROPS),
      id: o.id, kind: anno.kind === 'draw' ? 'line' : 'area',
      coords: anno.pts.map((p) => { const { x, y } = ptXY(p); return at(x, y) }),
    }
    return settle({ drawing })
  }
  if (anno.kind === 'circle' && anno.x != null && anno.y != null) {
    const drawing: Drawing = {
      ...pick(anno, SHARED_CIRCLE_PROPS),
      id: o.id, kind: 'circle', coords: [at(anno.x, anno.y)],
      radiusM: anno.radiusN != null ? anno.radiusN * widthM : undefined,
    }
    return settle({ drawing })
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

const sameCoord = (a: LngLat | undefined, b: LngLat | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1])

const sameCoords = (a: LngLat[] | undefined, b: LngLat[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((c, i) => sameCoord(c, b[i])))

/**
 * Did this map body MOVE, or was it only re-styled? Measured against the object's OWN baked
 * body — which is exactly what the Karte put under the operator's finger — so the question
 * being answered is «did that gesture change the position», not «does the fit still agree».
 */
function movedOnMap(prev: TacticalObject, body: { entity?: Entity; drawing?: Drawing }): boolean {
  if (body.entity) return !prev.entity || !sameCoord(prev.entity.coord, body.entity.coord)
  // ⚠️ NOT `radiusM`: widening an Absperrkreis is a size change, and reading it as a placement
  // tore the circle off its sheet — silently, on a drag that says nothing about where it stands.
  // It crosses as `radiusN` through the fit instead, like every other unit-bearing field.
  if (body.drawing) return !prev.drawing || !sameCoords(prev.drawing.coords, body.drawing.coords)
  return false
}

/**
 * A Karte edit of a SHEET-anchored object, written back where its truth lives: onto the anno.
 *
 * ⚠️ It has to land here and not on the map body, because the bake re-derives that body from
 * this anno on the very next plan write or fit change — an edit parked on the map body would
 * simply disappear. Only the vocabulary both surfaces share crosses: `entitySharedProps` (the
 * complement of georefTwins · ENTITY_MAP_ONLY) for point bodies, the SHARED_*_PROPS lists for
 * paths, plus the two renames the transfer converters have always made — the map's `floor`
 * badge is the sheet's `storey`, and a note's text is `text` rather than `label`.
 *
 * ⚠️ The UNIT-BEARING fields cross through the plan's own fit, which is why this seam is handed
 * one: a metre width means nothing on paper, and dropping it meant the Karte silently refused
 * edits it had just accepted — a widened Form snapped back, a Hubretter's reach never moved, and
 * a position marked on a plan-drawn Trupp lost its breadcrumb on the next bake. Without a fit
 * (an unlinked sheet) they stay out, which is the honest answer: nothing on that sheet has a
 * ground size yet either.
 *
 * ⚠️ What does NOT cross: the position — that flips the anchor instead (applyDocToObjects) — and
 * `noteW`. A note's width is deliberately per-surface (`noteW` is screen px, `wN` a fraction of
 * the plan width); it survives a re-bake through BAKE_PRESERVED instead.
 */
function annoAfterMapEdit(anno: BoardAnno, body: { entity?: Entity; drawing?: Drawing }, plan?: PlanFit, movedBy?: 'machine'): BoardAnno {
  const { entity, drawing } = body
  const widthM = plan ? planGroundWidthM(plan.fit, plan.aspect) : undefined
  /**
   * ⚠️ A MACHINE moved it, so the position crosses instead of flipping the anchor. Only a hand
   * places an object (tmp/design-unified-objects.md · «last hand-placement owns the truth»); the
   * live-GPS pass re-routes an attached Leitung on every poll, and read as a placement it would
   * have torn plan-drawn hoses off their sheet with nobody touching anything.
   */
  const at = (c: LngLat) => plan!.fit.toPlan({ lng: c[0], lat: c[1] })
  const machine = movedBy === 'machine' && plan
  const point = (c: LngLat | undefined) => (machine && c ? { x: at(c).x, y: at(c).y } : null)
  const path = (coords: LngLat[] | undefined): { pts: BoardPoint[] } | null => {
    if (!machine || !coords?.length) return null
    // a per-point storey is the paper's own answer and rides along by index; a machine write
    // moves a line ON the sheet, never between floors
    return { pts: coords.map((c, i): BoardPoint => { const p = at(c); const f = anno.pts?.[i]?.[2]; return f == null ? [p.x, p.y] : [p.x, p.y, f] }) }
  }
  /** a metre length as a fraction of the sheet's ground width — absent without a fit */
  const asN = (m: number | undefined) => (m != null && widthM ? m / widthM : undefined)
  if (entity) {
    const shared = entitySharedProps(entity)
    if (anno.kind === 'text') return { ...anno, ...shared, text: entity.label, storey: entity.floor, ...point(entity.coord) }
    // the chip's name lives in `text`, and truppId/`t` are map-only for a SYMBOL but are the
    // shared identity of a team marker — which is the one kind that carries them. Its recorded
    // breadcrumbs are part of the incident record, so they come back through the fit too.
    if (anno.kind === 'resource') {
      const trail = plan && entity.trail
        ? entity.trail.map(({ coord, t }) => { const p = plan.fit.toPlan({ lng: coord[0], lat: coord[1] }); return { x: p.x, y: p.y, t } })
        : anno.trail
      return { ...anno, ...shared, text: entity.label, truppId: entity.truppId, t: entity.t, trail, ...point(entity.coord) }
    }
    if (anno.kind === 'shape') return { ...anno, ...shared, storey: entity.floor, ...(asN(entity.sizeM) != null ? { sizeN: asN(entity.sizeM) } : null), ...point(entity.coord) }
    return { ...anno, ...shared, storey: entity.floor, ...(asN(entity.reachM) != null ? { reachN: asN(entity.reachM) } : null), ...point(entity.coord) }
  }
  if (drawing) {
    if (anno.kind === 'circle') {
      return { ...anno, ...pick(drawing, SHARED_CIRCLE_PROPS), ...(asN(drawing.radiusM) != null ? { radiusN: asN(drawing.radiusM) } : null), ...point(drawing.coords[0]) }
    }
    return { ...anno, ...pick(drawing, SHARED_PATH_PROPS), ...path(drawing.coords) }
  }
  return anno
}

/**
 * The setDoc seam: apply a full `{entities, drawings}` document — the shape every map mutator
 * produces — onto the unified store.
 *
 * Now that the Karte renders sheet-anchored objects natively (viewsOf), the document CONTAINS
 * their baked bodies, and what comes back has to be read as a GESTURE rather than as the truth:
 *
 *   · moved on the Karte → ANCHOR FLIP. «Last hand-placement owns the truth»: the document's
 *     body becomes the object and the sheet body is dropped. Dragging a symbol off the building
 *     is exactly the statement that it no longer stands on that sheet.
 *   · re-styled only → the sheet keeps the anchor, and the shared props are written through
 *     onto its anno, where the next bake reads them back.
 *   · gone from the document → deleted on the Karte, and deleting an object deletes the object.
 *     A sheet object with no baked body was never on the Karte to delete, so its absence says
 *     nothing about it and it stays.
 *
 * Geo-anchored objects are replaced wholesale by the document, absence meaning deletion, as
 * before. Sheet-anchored records keep their store order; new map objects append.
 */
export function applyDocToObjects(
  objects: TacticalObject[],
  doc: { entities: Entity[]; drawings: Drawing[] },
  fits?: ReadonlyMap<string, PlanFit>,
  /** `false` = a MACHINE produced this document (the live-GPS re-route), so a changed position
   *  is not a hand-placement: it writes through onto the anno instead of flipping the anchor. */
  gesture = true,
): TacticalObject[] {
  const entities = new Map(doc.entities.filter((e) => !e.live).map((e) => [e.id, e])) // live overlays are derived, never records
  const drawings = new Map(doc.drawings.map((d) => [d.id, d]))
  const next: TacticalObject[] = []
  const sheetIds = new Set<string>()
  for (const o of objects) {
    if (!o.sheet) continue // geo-anchored objects are rebuilt from the document below
    sheetIds.add(o.id)
    const entity = entities.get(o.id)
    const drawing = drawings.get(o.id)
    if (!entity && !drawing) {
      if (o.entity || o.drawing) continue // it stood on the Karte, and it was deleted there
      next.push(o)
      continue
    }
    const body = entity ? { entity } : { drawing }
    const moved = movedOnMap(o, body)
    if (moved && gesture) next.push({ id: o.id, ...body })
    else {
      const plan = fits?.get(o.sheet.planId)
      const anno = annoAfterMapEdit(o.sheet.anno, body, plan, moved ? 'machine' : undefined)
      next.push({ ...o, entity: undefined, drawing: undefined, ...body, sheet: { ...o.sheet, anno } })
    }
  }
  for (const e of entities.values()) if (!sheetIds.has(e.id)) next.push({ id: e.id, entity: e })
  for (const d of drawings.values()) if (!sheetIds.has(d.id)) next.push({ id: d.id, drawing: d })
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

/** Map a bake over the store, giving the SAME array back when nothing moved — see `sameValue`.
 *  Everything that re-derives bodies goes through here, so «no change» never reaches the store. */
function bakeEach(objects: TacticalObject[], of: (o: TacticalObject) => TacticalObject): TacticalObject[] {
  let changed = false
  const next = objects.map((o) => { const b = of(o); if (b !== o) changed = true; return b })
  return changed ? next : objects
}

/** Re-derive the map bodies of ONE plan's objects — what a plan mutation owes the Karte. */
export function bakePlan(objects: TacticalObject[], planId: string, plan: PlanFit | undefined, defaultLayer: Entity['layer']): TacticalObject[] {
  return bakeEach(objects, (o) => (o.sheet?.planId === planId ? bakeGeoBody(o, plan, defaultLayer) : o))
}

/**
 * …and every plan's, for the two moments that owe it wholesale: a store just hydrated from a
 * blob, and a georeference that has just changed (a fit correction MOVES every symbol standing
 * on that sheet — see tmp/design-unified-objects.md · «Reference change»).
 */
export function bakeAll(objects: TacticalObject[], fits: ReadonlyMap<string, PlanFit>, defaultLayer: Entity['layer']): TacticalObject[] {
  return bakeEach(objects, (o) => (o.sheet ? bakeGeoBody(o, fits.get(o.sheet.planId), defaultLayer) : o))
}
