import type { BoardAnno, BoardPoint, Entity, LngLat } from '../types'
import type { GeorefFit, PlanPt } from './georef'
import { ROTATABLE } from './symbols'
import { SHAPE_DEFS } from './shapes'
import { entityToBoardSymbol, onSheet, planGroundWidthM, TWIN_CLIP_MARGIN } from './georefTwins'
import type { PlanFit, TacticalObject } from './tacticalObjects'

/**
 * The Karte, said in ONE sheet's own words — the second half of the unified object
 * (tmp/design-unified-objects.md, phase 2).
 *
 * An object's position is knowable on two surfaces, and it is STORED on the one it was last
 * hand-placed on. This module is the derivation for the other one: a geo-anchored object,
 * expressed as the annotation that sheet would have if the object had been drawn on it. The
 * sheet then renders and edits it with its own native chrome — no twin layer, no twin selection
 * list, no twin gesture — and an edit that MOVES it flips the anchor, at which point this
 * derivation stops and the stored anno takes over (lib/tacticalObjects · applyBoardToObjects).
 *
 * ⚠️ It is the exact mirror of `bakeGeoBody`, and the two have to stay inverse: a projected
 * anno that comes back from the sheet becomes the object's stored sheet body verbatim, so any
 * conversion this module makes that the bake does not undo would rotate, resize or displace the
 * object a little on every flip. Every asymmetry below is therefore deliberate and named.
 *
 * ## What is projected, and what is not
 *
 * ONLY geo-anchored objects. An object anchored on THIS sheet is drawn from its own anno, and
 * one anchored on ANOTHER sheet is not shown here at all — plan A's work never cluttered plan B
 * under the twins and must not start now. Live vehicles and responder positions are moments
 * rather than records; they project too, but as a read-only overlay the document never contains.
 *
 * ## The clip
 *
 * `toPlan` is defined for the whole world — a vehicle two kilometres away comes back as
 * `y = 37.4` and would smear along the sheet edge, or worse, sit just off it and look like it is
 * «at the building». So everything outside the sheet is DROPPED, with a small margin
 * (`TWIN_CLIP_MARGIN`) so a hydrant a hair past the paper edge still shows.
 */

/**
 * ⚠️ The sheet's own TURN, as a frame change carried in the data.
 *
 * A map glyph's bearing is north-referenced; on a sheet drawn at an angle to north the same
 * bearing has to be expressed relative to paper-up, and `fit.rotationDeg` is exactly that frame
 * change (georef · GeorefFit). Until the surfaces were unified this happened at RENDER time on
 * both sides, which meant the number in the record was north-referenced on one surface and
 * paper-referenced on the other depending on where you read it. Now it is applied here and undone
 * by the bake, so a stored rotation always means «relative to the paper it is stored on».
 *
 * Only for glyphs that HAVE a direction: a symbol with no rotation control (the Offizier, the
 * Sammelplatz) must not acquire one from the paper it happens to lie on.
 */
export const turnedToSheet = (deg: number | undefined, fit: GeorefFit, directional: boolean): number | undefined =>
  (directional ? (deg ?? 0) + fit.rotationDeg : deg)

/** …and back to north, the inverse the bake applies. */
export const turnedToGround = (deg: number | undefined, fit: GeorefFit, directional: boolean): number | undefined =>
  (directional ? (deg ?? 0) - fit.rotationDeg : deg)

/** Does this body's glyph carry a direction the paper's turn applies to? */
export const directionalGlyph = (o: { kind?: string; symbol?: string }): boolean =>
  o.kind === 'shape' || (o.kind === 'symbol' && !!o.symbol && ROTATABLE.has(o.symbol))

/** …and a SECOND one? `rotation2` aims the Grosslüfter's fan and the Hubretter's boom, and it is
 *  a north-referenced bearing exactly like `rotation` — so it takes the same frame change, or a
 *  flip on a turned sheet would swing the boom while leaving the truck where it was. */
export const directionalGlyph2 = (o: { kind?: string; rotation2?: number }): boolean =>
  o.rotation2 != null

const pt = (fit: GeorefFit, c: LngLat): PlanPt => fit.toPlan({ lng: c[0], lat: c[1] })

/**
 * Project ONE object's map body onto a sheet, or `null` when it does not land on it.
 *
 * The anno carries the object's OWN id — it is the same object, and that is what lets an edit
 * coming back off the sheet be matched to it. (The twin era prefixed these ids precisely because
 * a projection was not allowed to be the object; it is now.)
 */
export function projectOnto(o: TacticalObject, plan: PlanFit, margin = TWIN_CLIP_MARGIN): BoardAnno | null {
  if (o.sheet) return null // anchored on a sheet: drawn there natively, and nowhere else
  const { fit } = plan
  const widthM = planGroundWidthM(fit, plan.aspect)
  const asN = (m: number | undefined, fallback?: number) => {
    const v = m ?? fallback
    return v == null ? undefined : v / widthM
  }
  const e = o.entity
  if (e) {
    if (e.live) return null // a moment, not a record — see `liveOverlay`
    const p = pt(fit, e.coord)
    if (!onSheet(p, margin)) return null
    const turn = (deg: number | undefined) => turnedToSheet(deg, fit, directionalGlyph(e))
    if (e.kind === 'symbol') {
      const anno = entityToBoardSymbol(e, p, widthM)
      return anno ? { ...anno, rotation: turn(anno.rotation), rotation2: turnedToSheet(anno.rotation2, fit, directionalGlyph2(anno)) } : null
    }
    if (e.kind === 'note') {
      return {
        // ⚠️ `e.label` verbatim, NOT `?? ''` — the bake reads `text ?? label`, so an empty
        // string would come back as a note that HAS a label, and absent must stay absent.
        id: o.id, kind: 'text', x: p.x, y: p.y, text: e.label, color: e.color,
        notePlain: e.notePlain, noteSize: e.noteSize, noteAutoW: e.noteAutoW,
        rotation: e.rotation, storey: e.floor,
      }
    }
    if (e.kind === 'shape') {
      return {
        id: o.id, kind: 'shape', shape: e.shape, x: p.x, y: p.y,
        // ⚠️ the SAME default the surfaces draw an unsized Form at (lib/shapes · SHAPE_DEFS).
        // A flat 40 m here meant an unsized Pfeil visibly resized the moment it was flipped.
        sizeN: asN(e.sizeM, SHAPE_DEFS[e.shape ?? 'square'].defaultSizeM),
        aspect: e.aspect, rotation: turn(e.rotation),
        rotation2: turnedToSheet(e.rotation2, fit, directionalGlyph2(e)),
        color: e.color, stop: e.stop, carrier: e.carrier, reverse: e.reverse, strokeW: e.strokeW,
        fillOpacity: e.fillOpacity, hatch: e.hatch, sharpCorners: e.sharpCorners, locked: e.locked,
        storey: e.floor,
      }
    }
    if (e.kind === 'team') {
      return {
        id: o.id, kind: 'resource', x: p.x, y: p.y, text: e.label, color: e.color,
        truppId: e.truppId, t: e.t,
        trail: e.trail?.map(({ coord, t }) => { const q = pt(fit, coord); return { x: q.x, y: q.y, t } }),
      }
    }
    return null // photo: media, not a place on the paper
  }
  const d = o.drawing
  if (!d) return null
  if (d.kind === 'circle') {
    // ⚠️ A circle stays a CIRCLE. The twin era turned it into an area ring, on the grounds that
    // the Plan had no circle primitive — it has had one for a while (`radiusN`), and a ring would
    // not round-trip: the flip would store a polygon where the object is a centre and a radius.
    const p = pt(fit, d.coords[0])
    if (!onSheet(p, margin)) return null
    return {
      id: o.id, kind: 'circle', x: p.x, y: p.y, radiusN: asN(d.radiusM),
      color: d.color, fillOpacity: d.fillOpacity, hatch: d.hatch, locked: d.locked,
      showDistance: d.showDistance,
    }
  }
  const pts = d.coords.map((c): BoardPoint => { const q = pt(fit, c); return [q.x, q.y] })
  if (pts.length < (d.kind === 'line' ? 2 : 3)) return null
  // A shape whose bounding box meets the paper survives even when every vertex lies just outside
  // — the board clips the SVG at its own edge, and a Fläche around the building is exactly that.
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
  if (Math.max(...xs) < -margin || Math.min(...xs) > 1 + margin || Math.max(...ys) < -margin || Math.min(...ys) > 1 + margin) return null
  // The label and the FKS end tag are anchored to the GROUND on the Karte (`labelAt`,
  // `endLabelAt`) and to the ink on the sheet (a nudge off the default spot), so they cross as
  // the offset from that default: the midpoint for the label, 72 % along the last segment for
  // the tag — the one rule both surfaces draw with.
  const mid = pts[Math.floor((pts.length - 1) / 2)]
  const n = pts.length
  const tagBase = d.kind === 'line' && n >= 2
    ? [pts[n - 2][0] + (pts[n - 1][0] - pts[n - 2][0]) * 0.72, pts[n - 2][1] + (pts[n - 1][1] - pts[n - 2][1]) * 0.72]
    : null
  const labelAt = d.labelAt ? pt(fit, d.labelAt) : null
  const endAt = d.endLabelAt ? pt(fit, d.endLabelAt) : null
  return {
    id: o.id, kind: d.kind === 'line' ? 'draw' : 'area', pts,
    color: d.color, width: d.width, dashed: d.dashed, arrow: d.arrow, arrowStop: d.arrowStop,
    marker: d.marker, showDistance: d.showDistance, label: d.label, fillOpacity: d.fillOpacity,
    // ⚠️ Schraffur crosses too. It is FKS MEANING, not decoration — a «betroffene Fläche»
    // mirrored as an ordinary washed one says something else about the ground (01.09.).
    hatch: d.hatch,
    labelDx: labelAt && mid ? labelAt.x - mid[0] : undefined,
    labelDy: labelAt && mid ? labelAt.y - mid[1] : undefined,
    endDx: endAt && tagBase ? endAt.x - tagBase[0] : undefined,
    endDy: endAt && tagBase ? endAt.y - tagBase[1] : undefined,
    teilstueck: d.teilstueck, content: d.content, lineNo: d.lineNo, floorTag: d.floorTag,
    truppId: d.truppId,
    // ⚠️ The lock crosses too. Without it a Fläche locked on the Karte was still draggable
    // through its mirror on the Plan, which defeats the whole point of locking it (01.09.).
    locked: d.locked,
  }
}

/** …every object that lands on this sheet, in store order. */
export function projectedAnnos(objects: TacticalObject[], plan: PlanFit, margin = TWIN_CLIP_MARGIN): BoardAnno[] {
  const out: BoardAnno[] = []
  for (const o of objects) {
    const anno = projectOnto(o, plan, margin)
    if (anno) out.push(anno)
  }
  return out
}

/**
 * The live feed on this sheet: vehicles and shared responder positions, as annos the sheet draws
 * but never owns. They are moments rather than records — nothing places them, nothing may edit
 * them, and they are not part of the document the operator is drawing on (the exact mirror of
 * the Karte, where the live layer is concatenated in at render time and never reaches the store).
 *
 * ⚠️ A responder's glyph is a ringed disc, and letting its centre sit in the generic 2 % margin
 * while the board clips at the paper edge leaves a white crescent plus a caption — the stray
 * «Trupp marker thing» from the field. Someone outside this plan is simply outside.
 */
export interface LiveMark {
  id: string
  /** where it stands on the paper */
  pt: PlanPt
  entity: Entity
  /** the sheet's own turn, so a directional glyph can be drawn in the paper's frame */
  rotationDeg: number
}

export function liveOverlay(entities: Entity[], plan: PlanFit, margin = TWIN_CLIP_MARGIN): LiveMark[] {
  const out: LiveMark[] = []
  for (const e of entities) {
    const p = pt(plan.fit, e.coord)
    if (!onSheet(p, e.kind === 'person' ? 0 : margin)) continue
    out.push({ id: e.id, pt: p, entity: e, rotationDeg: plan.fit.rotationDeg })
  }
  return out
}
