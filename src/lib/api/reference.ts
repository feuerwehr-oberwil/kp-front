// Reference datasets (hydrants/Leitungskataster/canton-WMS/object plans/checklists) + the
// per-station reference-layer render config. Station data — never bundled; loaded via admin.
import { apiGet, apiPut, apiUpload, ApiError } from '../api'
import { appConfig } from '../../config/appConfig'

export interface ReferenceDataset {
  id: string
  object_id: string | null
  module: string | null
  kind: string // 'pdf' | 'geojson' | 'symbols'
  title: string | null
  source_type: string
  source_note: string | null
  content_type: string | null
  size_bytes: number | null
  feature_count: number | null
  current_version: number
  updated_at: string
}

export const listReference = () => apiGet<ReferenceDataset[]>('/api/reference')
/**
 * URL for fetching a reference dataset file (geojson/symbols/pdf), same-origin.
 *
 * ⚠️ Pass the dataset's `current_version` for anything that gets REPLACED in place. Re-uploading
 * a Modul-PDF writes new bytes under the same dataset id — the id is the stable handle, which is
 * the point of it — so the URL stayed identical while the sheet changed, and three caches keyed
 * on that URL kept serving the old plan: the service worker's `reference-data` entry (stale-
 * while-revalidate, 30 days), pdf.js' document cache, and the rendered-bitmap cache. The version
 * IS the cache key; `store_plan` bumps it on every write for exactly this reason. The backend
 * ignores the query string (api/report · _REFERENCE_URL, api/reference reads the path param).
 */
export const referenceUrl = (id: string, version?: number) =>
  `/api/reference/${encodeURIComponent(id)}${version == null ? '' : `?v=${version}`}`
export async function uploadReference(id: string, file: Blob, filename: string, sourceNote?: string) {
  const form = new FormData()
  form.append('file', file, filename)
  if (sourceNote) form.append('source_note', sourceNote)
  return apiUpload<ReferenceDataset>(`/api/reference/${encodeURIComponent(id)}`, form, 'PUT')
}

/**
 * The `geojson` URL a reference-layer config row points at, for a dataset in the store.
 *
 * ⚠️ `geo:` stays UNENCODED — this string is written into the deployment config, where the CLI
 * writes exactly this shape (`admin_geodata · _to_reference_layers`) and two consumers match on
 * it literally: `IncidentWorkspace · withGeoBbox` (which appends the offline crop, and already
 * copes with an existing query string) and the Kartenebenen viewer's `datasetIdOf`. Passing it
 * through `referenceUrl` would produce `geo%3A…` and silently break both.
 *
 * The version rides along for the reason `referenceUrl` documents above: replacing a layer's
 * file keeps the dataset id, so the URL is the only cache key the service worker's
 * `reference-data` entry (stale-while-revalidate, 30 days) ever sees. Without it a station that
 * corrected its hydrants kept rendering yesterday's file on every tablet that had looked once.
 */
export const geoLayerUrl = (datasetId: string, version?: number) =>
  `/api/reference/${datasetId}${version == null ? '' : `?v=${version}`}`

/** The dataset a GeoJSON layer's config URL points at (`/api/reference/geo:hydrant?v=3` →
 *  `geo:hydrant`), or null when the layer is sourced from somewhere else entirely (an external
 *  https GeoJSON, or a raster layer that has no `geojson` at all). */
export function geoDatasetId(url: unknown): string | null {
  return typeof url === 'string' ? (url.match(/geo:[A-Za-z0-9_.-]+/)?.[0] ?? null) : null
}

/**
 * One layer merged into a stored `referenceLayers` list — the merge rule, without the write.
 *
 * ⚠️ MERGED over the previous row, never replacing it, and IN PLACE. `referenceLayers` has three
 * writers (`admin_geodata push`, the Kartenebenen admin page, `upsertReferenceLayer` below), and
 * the fields any one of them shows are a subset: `nightColor`, `opacity`, `maxzoom`, `symbol` and
 * `autoActivate` are CLI-written and invisible in the browser, so rebuilding a row from the
 * visible fields deletes them the first time somebody fixes a label. Position is kept because the
 * Ebenen panel lists layers in document order — re-appending an edited layer reshuffled it.
 */
export function mergeReferenceLayer<T extends { id?: string }>(existing: T[], layer: T): T[] {
  const at = existing.findIndex((l) => l?.id === layer.id)
  if (at < 0) return [...existing, layer]
  return existing.map((l, i) => (i === at ? { ...l, ...layer } : l))
}

/** A render-config entry for a per-station reference layer (mirrors the backend
 *  ReferenceLayerConfig / admin_geodata manifest — see deploymentConfig.ts). */
export interface ReferenceLayerInput {
  id: string
  group?: string
  label?: string
  icon?: string
  kind?: 'wms' | 'wmts' | 'geojson'
  tiles?: string[]
  geojson?: string
  vectorKind?: 'line' | 'point'
  symbol?: string
  color?: string
  nightColor?: string
  opacity?: number
  attribution?: string
  autoActivate?: string[]
}

/**
 * Add (or replace by id) one reference layer in the deployment config. Read-modify-write
 * on the full-document `PUT /api/config` — **admin-only**, like `PUT /api/reference/{id}`:
 * both answer 401 «Admin-Anmeldung erforderlich» without an admin session, which is why the
 * callers gate on one. `integrations` is env-derived and stripped, mirroring ConfigEditor's
 * save. This is the same render config the CLI `admin_geodata load` writes; it's what
 * `referenceLayersFromConfig` turns into map layers.
 *
 * ⚠️ `If-Match` is NOT optional. `put_config` answers **428** to any request that carries
 * browser fetch metadata and no version token (api/config · put_config), and `fetch` always
 * sends `Sec-Fetch-Site` — so this function used to fail with «Diese Seite ist veraltet» on
 * every single call, and «Neue Geo-Ebene …» in the Datenquellen panel never once worked.
 * (Confirmed against a running station, 2026-08-16: 428 without the header, 200 with it.)
 * The token comes from the GET above, one line earlier, which is what makes the guard cheap
 * here: this is a read-modify-write, so the version it read IS the version it writes over.
 *
 * A 409 therefore means somebody else wrote the document in the few milliseconds between the
 * two calls — the CLI, the Verwaltung, a second tablet. Re-raised as «nochmals versuchen»,
 * because a fresh read-modify-write is exactly what fixes it and the caller must NOT retry the
 * whole document blindly (that is the clobber the guard exists for).
 *
 * ⚠️ NO TOKEN AT ALL is a different case again, and it must not be sent. `GET /api/config` always
 * answers with a `version` — `_version()` hashes the stored document and hashes `{}` for a station
 * that has never been written — so a missing one means the response was not the config document:
 * a captive portal, a proxy's error page, an offline shell. Sending the PUT anyway produced a 428
 * relabelled «wurden gerade an anderer Stelle geändert. Bitte nochmals drücken», an instruction
 * that can never resolve because pressing again reads the same non-answer. It fails here instead,
 * saying the one thing that does help — and, more importantly, without offering the API a
 * full-document write built on a document nobody managed to read.
 */
export async function upsertReferenceLayer(layer: ReferenceLayerInput): Promise<void> {
  const cfg = await apiGet<Record<string, unknown>>('/api/config')
  // Opaque token the endpoint derives from the stored document (api/config · _version).
  const version = typeof cfg.version === 'string' && cfg.version ? cfg.version : null
  if (!version) throw new ApiError(428, appConfig.copy.datenquellen.layerNoVersion)
  delete cfg.integrations
  const existing = Array.isArray(cfg.referenceLayers) ? (cfg.referenceLayers as ReferenceLayerInput[]) : []
  // Merge over the previous row (not replace): fields the caller doesn't edit — e.g. a
  // CLI-written `autoActivate` — survive a re-upload of the same layer id. Same rule the
  // Kartenebenen page applies to its draft, which is why it lives in one function.
  cfg.referenceLayers = mergeReferenceLayer(existing, layer)
  try {
    await apiPut('/api/config', cfg, { 'If-Match': version })
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 428)) {
      throw new ApiError(e.status, appConfig.copy.datenquellen.layerConflict)
    }
    throw e
  }
}

/** What a checked file turned out to be. The `reason` is what separates «this is not JSON» from
 *  «this is LV95»: only the latter has a fix worth spelling out (reproject to EPSG:4326), and a
 *  caller cannot tell the cases apart from a German sentence without matching on prose. */
export type GeojsonInspection =
  | { ok: true; count: number; geometry: 'point' | 'line' }
  | { ok: false; reason: 'json' | 'shape' | 'projection'; msg: string }

/** Quick client-side GeoJSON sanity check so the operator gets immediate feedback before the
 *  upload: must be a FeatureCollection in WGS84 [lng, lat] (LV95-looking coords are rejected,
 *  matching the backend guard in admin_geodata). Returns the feature count — and the geometry
 *  the file actually holds, so the upload form can PRESELECT «Punkte»/«Linien» instead of asking
 *  a question the file already answers — or an error message. */
export async function inspectGeojson(file: Blob): Promise<GeojsonInspection> {
  let data: unknown
  const copy = appConfig.copy.incidents
  try {
    data = JSON.parse(await file.text())
  } catch {
    return { ok: false, reason: 'json', msg: copy.geojsonNotJson }
  }
  const fc = data as { type?: string; features?: unknown }
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return { ok: false, reason: 'shape', msg: copy.geojsonNotFc }
  }
  const c = firstCoord(fc.features as unknown[])
  if (c && (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
    return { ok: false, reason: 'projection', msg: copy.geojsonNotWgs84 }
  }
  const features = fc.features as unknown[]
  return { ok: true, count: features.length, geometry: firstGeometryKind(features) }
}

/** Point-ish or line-ish, from the first feature that has a geometry at all. A hydrant export is
 *  Points, a Leitungskataster LineStrings — and everything with an extent (polygons included)
 *  renders through the same stroked path as a line (deploymentConfig · mapReferenceLayers, where
 *  'point' is the only value that branches). Empty / geometry-less → 'line', the renderer's own
 *  default. */
function firstGeometryKind(features: unknown[]): 'point' | 'line' {
  for (const f of features) {
    const t = (f as { geometry?: { type?: unknown } } | null)?.geometry?.type
    if (typeof t === 'string') return t === 'Point' || t === 'MultiPoint' ? 'point' : 'line'
  }
  return 'line'
}

/** First [x, y] pair under any feature geometry (any nesting). */
function firstCoord(features: unknown[]): [number, number] | null {
  const dig = (node: unknown): [number, number] | null => {
    if (Array.isArray(node)) {
      if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') return [node[0], node[1]]
      for (const child of node) { const r = dig(child); if (r) return r }
    }
    return null
  }
  for (const f of features) {
    const geom = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry
    if (geom) { const r = dig(geom.coordinates); if (r) return r }
  }
  return null
}
