import type { Drawing, Entity, LineAttachment, LngLat, Trupp } from '../types'
import { boundaryPoint, DEFAULT_OBJECT_ROUTING, isMagnetEntity, lineEndTargets, type AttachableLine, type MagneticTarget } from '../lib/lineAttachments'
import { markerTakesLineEnd, truppIdForAttachment, type LinkableLine } from '../lib/truppLines'
import { symPx, teamStripPx, TEAM_DOT_PX } from '../lib/mapView'

/** The slice of a MapLibre map the target walk needs — the live map passes as it is. */
export interface MapProjector {
  project: (c: LngLat) => { x: number; y: number }
  unproject: (p: [number, number]) => { lng: number; lat: number }
}

/** What the Lage shows right now, as the magnet reads it. `drawings` are RESOLVED (where the ink
 *  is drawn); `attachmentLines` carry a dragged end at the finger (MapView). */
export interface MagnetScene {
  entities: Entity[]
  drawings: Drawing[]
  attachmentLines: AttachableLine<LngLat>[]
  trupps: Trupp[]
  zoom: number
  bearing: number
  symMul: number
}

/** The id a line being DRAWN goes by as a magnet source (lib/useDraftMagnet). */
export const DRAFT_SOURCE = '__draft__'

/**
 * Every magnetic target a line end of `sourceId` can couple to at `at` — the Lage's half of the
 * one magnet (lib/useDraftMagnet, MapView · candidatesAt; the Plan's twin is Whiteboard ·
 * planCandidatesAt). Symbols offer the nearest point of their glyph box, a Trupp marker the
 * nearest point of its [dot][name] strip, and line ends their free ports. `draftStart` is the
 * claim a draft's first end has already made, so one stroke cannot put a Trupp on both ends.
 */
export function mapMagnetTargets(map: MapProjector, scene: MagnetScene, sourceId: string, at: LngLat, draftStart?: LineAttachment): MagneticTarget[] {
  const { entities, drawings, attachmentLines, trupps, zoom, bearing, symMul } = scene
  const pointer = map.project(at)
  // ── EINE Leitung, EIN Trupp, schon am Magneten (lib/truppLines · markerTakesLineEnd) ──
  // A hose that already has a crew does not SEE another Trupp's marker: no ring, no dwell, no
  // attach — the end just stays under the finger. Refusing only the link left the picture
  // claiming a second crew, which is the «Trupp an beiden Enden» this rule exists to stop.
  // A DRAFT is judged by the claim its first end already made, so one stroke cannot do it either.
  const truppMarkers = entities.flatMap((e) => (e.kind === 'team' ? [{ id: e.id, truppId: e.truppId }] : []))
  const srcLine: LinkableLine | undefined = drawings.find((d) => d.id === sourceId)
    ?? (sourceId === DRAFT_SOURCE ? { id: sourceId, truppId: truppIdForAttachment(draftStart, truppMarkers) } : undefined)
  const objectTargets: MagneticTarget[] = entities
    .filter((e) => isMagnetEntity(e) && Array.isArray(e.coord)
      && (e.kind !== 'team' || markerTakesLineEnd(srcLine, trupps, { id: e.id, truppId: e.truppId })))
    .map((e) => {
      const c = map.project(e.coord), size = e.kind === 'team' ? 56 : symPx(e.kind, e.coord[1], zoom, symMul)
      // A Trupp marker is a STRIP – [dot][name] hanging right of the coordinate – and the hand
      // aims at the name as readily as at the dot (15.09.). The target point is the nearest
      // point of that strip's box, so an end laid over the name is «on» the marker; the
      // coupling itself still resolves to the dot (resolveLinePoints · objectPoint).
      if (e.kind === 'team') {
        const w = teamStripPx(e.label ?? '')
        const x0 = c.x - TEAM_DOT_PX / 2 - 6, x1 = x0 + w + 12, y0 = c.y - 16, y1 = c.y + 16
        const point: [number, number] = [Math.min(Math.max(pointer.x, x0), x1), Math.min(Math.max(pointer.y, y0), y1)]
        return { key: `object:${e.id}`, target: { kind: 'object', id: e.id, live: !!e.live }, point, defaultRouting: DEFAULT_OBJECT_ROUTING }
      }
      const edge = boundaryPoint({ shape: 'rect', center: [c.x, c.y], width: size, height: e.kind === 'vehicle' ? size * 0.7 : size, rotation: (e.rotation ?? 0) - bearing }, [pointer.x, pointer.y])
      return { key: `object:${e.id}`, target: { kind: 'object', id: e.id, live: !!e.live }, point: edge, defaultRouting: DEFAULT_OBJECT_ROUTING }
    })
  const px = (c: LngLat): [number, number] => { const p = map.project(c); return [p.x, p.y] }
  const lineTargets = lineEndTargets(drawings
    // a Wand is layout: no Leitung couples onto its end (the Plan's rule, Whiteboard · planCandidatesAt)
    .filter((d) => d.kind === 'line' && !d.role && d.id !== sourceId && d.coords.length >= 2)
    .map((d) => ({
      id: d.id, teilstueck: d.teilstueck, width: d.width,
      start: [px(d.coords[0]), px(d.coords[1])], end: [px(d.coords[d.coords.length - 1]), px(d.coords[d.coords.length - 2])],
    })), attachmentLines, sourceId, (p) => { const ll = map.unproject(p); return [ll.lng, ll.lat] })
  return [...objectTargets, ...lineTargets]
}
