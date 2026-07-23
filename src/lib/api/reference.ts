// Reference datasets (hydrants/Leitungskataster/canton-WMS/object plans/checklists) + the
// per-station reference-layer render config. Station data — never bundled; loaded via admin.
import { apiGet, apiPut, apiUpload } from '../api'
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
/** URL for fetching a reference dataset file (geojson/symbols/pdf), same-origin. */
export const referenceUrl = (id: string) => `/api/reference/${encodeURIComponent(id)}`
export async function uploadReference(id: string, file: Blob, filename: string, sourceNote?: string) {
  const form = new FormData()
  form.append('file', file, filename)
  if (sourceNote) form.append('source_note', sourceNote)
  return apiUpload<ReferenceDataset>(`/api/reference/${encodeURIComponent(id)}`, form, 'PUT')
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

/** Add (or replace by id) one reference layer in the deployment config. Read-modify-write
 *  on the full-document `PUT /api/config` (editor-only) — `integrations` is env-derived
 *  and stripped, mirroring ConfigEditor's save. This is the same render config the CLI
 *  `admin_geodata load` writes; it's what `referenceLayersFromConfig` turns into map layers. */
export async function upsertReferenceLayer(layer: ReferenceLayerInput): Promise<void> {
  const cfg = await apiGet<Record<string, unknown>>('/api/config')
  delete cfg.integrations
  const existing = Array.isArray(cfg.referenceLayers) ? (cfg.referenceLayers as ReferenceLayerInput[]) : []
  // Merge over the previous row (not replace): fields the panel doesn't edit — e.g. a
  // CLI-written `autoActivate` — survive a re-upload of the same layer id.
  const prev = existing.find((l) => l?.id === layer.id)
  cfg.referenceLayers = [...existing.filter((l) => l?.id !== layer.id), prev ? { ...prev, ...layer } : layer]
  await apiPut('/api/config', cfg)
}

/** Quick client-side GeoJSON sanity check so the operator gets immediate feedback before the
 *  upload: must be a FeatureCollection in WGS84 [lng, lat] (LV95-looking coords are rejected,
 *  matching the backend guard in admin_geodata). Returns the feature count or an error message. */
export async function inspectGeojson(file: Blob): Promise<{ ok: true; count: number } | { ok: false; msg: string }> {
  let data: unknown
  const copy = appConfig.copy.incidents
  try {
    data = JSON.parse(await file.text())
  } catch {
    return { ok: false, msg: copy.geojsonNotJson }
  }
  const fc = data as { type?: string; features?: unknown }
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return { ok: false, msg: copy.geojsonNotFc }
  }
  const c = firstCoord(fc.features as unknown[])
  if (c && (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
    return { ok: false, msg: copy.geojsonNotWgs84 }
  }
  return { ok: true, count: (fc.features as unknown[]).length }
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
