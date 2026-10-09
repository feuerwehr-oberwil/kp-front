// A Verlauf photo that knows where it was taken — and the photo marker it can become.
//
// The chain (F16, 08.10.2026):
//   1. a picture is picked (composer camera/upload, the quick-photo target); its EXIF is read
//      from the ORIGINAL file (lib/exif) and kept for this session by its blob: URL
//      (`rememberPhotoGeo`) — before lib/imagePrep re-encodes it through a canvas and every
//      byte of metadata is gone;
//   2. the row is written with `photoGeo` beside `photoUrls` (`rowGeoFor`): position, heading
//      and time only, and only for a picture taken NEAR THE EINSATZ — a home photo's position
//      never reaches the append-only record. Nothing else from the file is kept (no camera, no
//      owner, no serial), and the uploaded file itself goes up without its metadata
//      (lib/stripMetadata, lib/imagePrep);
//   3. the row's detail sheet (and the save toast) offer «Auf Karte setzen» for a picture whose
//      position lies near the Einsatz (`photoPlacement`) — and NOTHING for a picture without
//      one: no empty button, no explanation where there is nothing to explain;
//   4. placing writes ONE ordinary `kind: 'photo'` entity (`photoMarker`, its id derived from
//      the picture so two devices placing it make one) through the store's
//      `commit`, so it is a step on the one undo timeline like any placed symbol, synced and
//      merged by id, selected and removed with the Karte's own chrome.
//
// ⚠️ The alignment of `photoGeo` with the row's pictures is BY INDEX AS CAPTURED. The persisted
// row only lists uploaded pictures (journalStore · stripSessionUrls), so on another device a row
// whose first picture is still pending shows a shorter list, and index 0 there is the capture's
// index 1. Every reader therefore goes through `rowPhotoGeo`, which trusts the alignment only
// while the counts match — a mismatch is «no position», never the wrong one.
//
// ⚠️ A marker names its picture by row + index (`photoOf`), not by URL: a picture placed while
// offline is a session blob: URL that means nothing anywhere else. The map reads the row's
// CURRENT URL (`resolvePhotoUrl`) — the server one on every device once the upload landed.

import { readExif, type ExifPhotoMeta } from './exif'
import { haversineM } from './geo'
import { rowPhotos } from './verlauf'
import type { Entity, LayerId, LngLat, PhotoGeo, TimelineEvent } from '../types'

/** A photo within this distance of the Einsatz's own coordinate may go on the Karte. Wide enough
 *  for the overview shot from the hill opposite, narrow enough that a picture from
 *  the library taken at home last week does not offer itself. */
export const PHOTO_NEAR_M = 3000
/** …and around the station's default view when the Einsatz has no coordinate of its own: the
 *  map still frames the Einsatzgebiet, the reference is just coarser. */
export const PHOTO_NEAR_FALLBACK_M = 15000

/** Reduce parsed EXIF to what a photo record keeps. `null` without a position: a time or a
 *  heading alone places nothing. */
export function toPhotoGeo(m: ExifPhotoMeta | null): PhotoGeo | null {
  if (!m || m.lat == null || m.lng == null) return null
  const g: PhotoGeo = { lat: round(m.lat, 7), lng: round(m.lng, 7) }
  if (m.alt != null) g.alt = round(m.alt, 1)
  if (m.heading != null) g.heading = round(m.heading, 1)
  if (m.takenAt) g.takenAt = m.takenAt
  return g
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

/** Is this synced value a usable position? Rows come from other devices. */
export function validGeo(g: unknown): g is PhotoGeo {
  if (!g || typeof g !== 'object') return false
  const { lat, lng, heading } = g as PhotoGeo
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && (heading == null || (typeof heading === 'number' && Number.isFinite(heading)))
}

// ── step 1: the session cache, keyed by the picture's blob: URL ──────────────────────────────

const pending = new Map<string, Promise<PhotoGeo | null>>()
const known = new Map<string, PhotoGeo | null>()

/** Read `file`'s position and keep it under `url` for this session. Never rejects. */
export function rememberPhotoGeo(url: string, file: Blob): Promise<PhotoGeo | null> {
  const p = readExif(file).then(toPhotoGeo, () => null).then((g) => {
    if (pending.get(url) === p) { known.set(url, g); pending.delete(url) }
    return g
  })
  pending.set(url, p)
  return p
}

/** What `rememberPhotoGeo` found for `url` — `null` for none, or while it is still reading. */
export const photoGeoOf = (url: string): PhotoGeo | null => known.get(url) ?? null

export function forgetPhotoGeo(url: string) { known.delete(url); pending.delete(url) }

/** Is a position near enough the Einsatz to belong to it? (`center`: the Einsatz's coordinate
 *  when it has one — `ownCoord` — else the station's default view, at the coarser radius.) */
export function nearIncident(g: Pick<PhotoGeo, 'lat' | 'lng'>, center: LngLat, ownCoord: boolean): boolean {
  return haversineM(center, [g.lng, g.lat]) <= (ownCoord ? PHOTO_NEAR_M : PHOTO_NEAR_FALLBACK_M)
}

/**
 * `photoGeo` for a new row with these pictures — absent when none of them has a position.
 *
 * ⚠️ Only a position NEAR THE EINSATZ is written (review of #304). The Verlauf is append-only and
 * reaches every device on the Einsatz, link viewers included, and the Rapport: a picture from the
 * library taken at home would otherwise put the operator's exact home coordinates into a record
 * nobody can take them out of. Outside the radius the picture is recorded as having no position.
 */
export function rowGeoFor(urls: readonly string[], center: LngLat, ownCoord: boolean): (PhotoGeo | null)[] | undefined {
  const geo = urls.map((u) => {
    const g = photoGeoOf(u)
    return g && nearIncident(g, center, ownCoord) ? g : null
  })
  return geo.some(Boolean) ? geo : undefined
}

/** How long a save waits for a position still being read before it goes without one. The read
 *  is a slice of the file's head (milliseconds); this only guards against a stuck file read. */
export const PHOTO_GEO_WAIT_MS = 1500

/**
 * Resolves once every one of `urls` has finished reading (or after PHOTO_GEO_WAIT_MS) — `null`
 * when nothing is pending, so the caller can stay synchronous on the ordinary path. A save
 * pressed the instant a picture was picked used to go out without the position.
 */
export function photoGeoSettled(urls: readonly string[]): Promise<void> | null {
  const waiting = urls.flatMap((u) => { const p = pending.get(u); return p ? [p] : [] })
  if (!waiting.length) return null
  return Promise.race([
    Promise.all(waiting).then(() => undefined),
    new Promise<void>((res) => setTimeout(res, PHOTO_GEO_WAIT_MS)),
  ])
}

// ── step 3: reading a row ────────────────────────────────────────────────────────────────────

/** Where picture `i` of `row` was taken, or `null` (none, or the alignment cannot be trusted). */
export function rowPhotoGeo(row: Pick<TimelineEvent, 'photoGeo' | 'photoUrl' | 'photoUrls'>, i: number): PhotoGeo | null {
  const geo = row.photoGeo
  if (!Array.isArray(geo) || geo.length !== rowPhotos(row).length) return null
  const g = geo[i]
  return validGeo(g) ? g : null
}

export type PhotoPlacement =
  /** near the Einsatz and not on the Karte yet — «Auf Karte setzen» */
  | { kind: 'place'; geo: PhotoGeo; distanceM: number }
  /** already on the Karte — «Auf Karte zeigen» */
  | { kind: 'placed'; geo: PhotoGeo; distanceM: number; entityId: string }
  /** has a position, but too far from the Einsatz to belong on its Karte */
  | { kind: 'far'; geo: PhotoGeo; distanceM: number }

/**
 * What picture `i` of `row` can do on the Karte. `null` when it has no position — the caller
 * then shows nothing at all.
 *
 * `center` is the Einsatz's coordinate when it has one (`ownCoord`), else the station's default
 * view (IncidentWorkspace · incidentView.center), with the coarser radius.
 */
export function photoPlacement(
  row: Pick<TimelineEvent, 'id' | 'photoGeo' | 'photoUrl' | 'photoUrls'>, i: number,
  center: LngLat, ownCoord: boolean, entities: readonly Entity[],
): PhotoPlacement | null {
  const geo = rowPhotoGeo(row, i)
  if (!geo) return null
  const distanceM = haversineM(center, [geo.lng, geo.lat])
  const placed = entities.find((e) => e.kind === 'photo' && e.photoOf?.row === row.id && e.photoOf.i === i)
  if (placed) return { kind: 'placed', geo, distanceM, entityId: placed.id }
  return nearIncident(geo, center, ownCoord)
    ? { kind: 'place', geo, distanceM }
    // only a row written before the radius applied at the write (or an Einsatz whose coordinate
    // moved since) can still carry a position this far out
    : { kind: 'far', geo, distanceM }
}

// ── step 4: the marker ───────────────────────────────────────────────────────────────────────

/** The marker's id is DERIVED from the picture it shows: two devices placing the same photo at
 *  the same time mint the same id, and the merge by id makes them one marker, not two. */
export const photoMarkerId = (rowId: string, i: number) => `ph-${rowId}-${i}`

/**
 * The photo marker for picture `i` of `row`, at the position it was taken from.
 *
 * ⚠️ A session `blob:` URL is NOT stored: it means nothing on another device or after a reload,
 * and the marker is synced. The map reads the row's current picture instead (`resolvePhotoUrl`);
 * a picture already uploaded keeps its server URL here as the fallback.
 */
export function photoMarker(row: Pick<TimelineEvent, 'id' | 'photoUrl' | 'photoUrls'>, i: number, geo: PhotoGeo, layer: LayerId): Entity {
  const e: Entity = { id: photoMarkerId(row.id, i), kind: 'photo', layer, coord: [geo.lng, geo.lat], photoOf: { row: row.id, i } }
  const url = rowPhotos(row)[i]
  if (url && !url.startsWith('blob:')) e.photoUrl = url
  if (geo.heading != null) e.heading = geo.heading
  if (geo.takenAt) e.takenAt = geo.takenAt
  return e
}

/**
 * The URL a photo marker shows: the row's CURRENT picture while the alignment holds (the upload
 * swapped a blob: for the server URL, or a reload re-minted the blob), else what was stored at
 * placement.
 */
export function resolvePhotoUrl(e: Entity, rowsById: ReadonlyMap<string, TimelineEvent>): string | undefined {
  const ref = e.photoOf
  if (!ref) return e.photoUrl
  const row = rowsById.get(ref.row)
  if (!row) return e.photoUrl
  const urls = rowPhotos(row)
  return (Array.isArray(row.photoGeo) && row.photoGeo.length === urls.length && urls[ref.i]) || e.photoUrl
}

/**
 * The URL every placed photo marker should show, as ONE string («id\turl» lines) — cheap to
 * compute on each Verlauf change, and compared by value: the map's entity list is rebuilt only
 * when a marker's picture actually changed, not on every new Verlauf row (review of #304).
 */
export function photoUrlKey(entities: readonly Entity[], rows: readonly TimelineEvent[]): string {
  if (!entities.some((e) => e.kind === 'photo' && e.photoOf)) return ''
  const byId = new Map(rows.map((r) => [r.id, r]))
  return entities
    .filter((e) => e.kind === 'photo' && e.photoOf)
    .map((e) => `${e.id}\t${resolvePhotoUrl(e, byId) ?? ''}`)
    .join('\n')
}

/** Apply a `photoUrlKey` to the entities — for the map's render only, never written back. The
 *  same array when nothing changes, so a memo downstream holds. */
export function withPhotoUrls(entities: Entity[], key: string): Entity[] {
  if (!key) return entities
  const urls = new Map(key.split('\n').map((l) => { const [id, url] = l.split('\t'); return [id, url || undefined] as const }))
  let changed = false
  const out = entities.map((e) => {
    if (!urls.has(e.id)) return e
    const url = urls.get(e.id)
    if (url === e.photoUrl) return e
    changed = true
    return { ...e, photoUrl: url }
  })
  return changed ? out : entities
}

/** Both in one, for a single entity (the selected marker's panel). */
export const withResolvedPhotos = (entities: Entity[], rows: readonly TimelineEvent[]): Entity[] =>
  withPhotoUrls(entities, photoUrlKey(entities, rows))

/** Compass index 0–7 (N, NO, O, …) of a bearing — the eight words `copy.weather.cardinals` has. */
export const cardinalIndex = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8

/** «120 m» / «1,4 km» — how far from the Einsatz a photo was taken. */
export function fmtDistance(m: number, locale = 'de-CH'): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  return `${(m / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`
}

/** «14:32» from an EXIF time — the clock it was taken at, as the camera stated it. */
export function takenClock(takenAt: string | undefined): string | null {
  const m = takenAt?.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : null
}
