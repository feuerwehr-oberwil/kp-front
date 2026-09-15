import { apiGet, apiGetRaw, apiPost, apiPut } from '../lib/api'
import type { PlanFloor } from '../lib/api/reference'
import type { GeoPt, GeorefPair } from '../lib/georef'

export type AlignmentStatus = 'pending' | 'processing' | 'ready' | 'needs_review' | 'no_match' | 'failed' | 'unavailable' | 'unsupported' | 'approved' | 'rejected'

/**
 * One sheet as the QUEUE knows it – everything the review wall, the object table and the tab
 * badge read, and nothing that grows with the building.
 *
 * ⚠️ No `reference_rings` here on purpose: 453 sheets carrying their outlines were a 21.5 MB,
 * 1.7 s list that the page re-polls every 15 s. The rings come per tile, lazily, from
 * `loadAlignmentOutline` – and in full with the detail (`loadAlignmentDetail`).
 */
export interface AlignmentListItem {
  id: number
  dataset_id: string
  plan_version: number
  page: number
  /** only the DETAIL resolves this – the list opens no PDF, so a queue row says null */
  page_count: number | null
  /** page → Geschoss of a floor pack; empty for an ordinary document */
  floors: PlanFloor[]
  can_approve: boolean
  object_name: string
  /** the Einsatzobjekt's coordinate – the review map's start when there are no reference rings */
  object_lng: number | null
  object_lat: number | null
  module: string
  title: string | null
  is_current: boolean
  status: AlignmentStatus
  edit_version: number
  pairs: GeorefPair[]
  aspect: number | null
  scale_m_per_u: number | null
  score: number | null
  coverage: number | null
  reason: string | null
  created_at: string
  updated_at: string
  approved_at: string | null
  reference_source: string | null
  reference_at: string | null
}

/** One sheet in FULL – what the detail answers, the only row that carries its reference geometry. */
export interface AlignmentItem extends AlignmentListItem {
  reference_rings: GeoPt[][]
}

/** What one review tile needs to draw its outlines, without the rest of the sheet's detail. */
export interface AlignmentOutline {
  reference_rings: GeoPt[][]
  reference_source: string | null
  reference_at: string | null
  pairs: GeorefPair[]
}

export interface AlignmentQueue {
  items: AlignmentListItem[]
  capability: { available: boolean; reason: string | null }
}

const BASE = '/api/admin/plan-alignments'
export const loadAlignmentQueue = () => apiGet<AlignmentQueue>(BASE)
export const loadAlignmentDetail = (id: number) => apiGet<AlignmentItem>(`${BASE}/${id}`)
/** the building outlines of ONE sheet – the review tile fetches them as it scrolls into view */
export const loadAlignmentOutline = (id: number, signal: AbortSignal) => apiGet<AlignmentOutline>(`${BASE}/${id}/outline`, { signal })
export const alignmentPreview = (id: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview`, { signal }).then(r => r.blob())
/** the review grid's small JPEG of the same page (the exact raster stays behind `alignmentPreview`) */
export const alignmentThumbnail = (id: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview?thumbnail=true`, { signal }).then(r => r.blob())
/** the exact PNG raster of ANOTHER page – the floor-pack editor's sheet to draw regions on */
export const alignmentPagePreview = (id: number, page: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview?page=${page}`, { signal }).then(r => r.blob())
/** the same small JPEG for ANOTHER page of the revision – the floor-pack editor's tiles */
export const alignmentPageThumbnail = (id: number, page: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview?thumbnail=true&page=${page}`, { signal }).then(r => r.blob())
// Every mutation answers the FULL sheet, and takes any queue row: a decision only needs the
// sheet's id and its CAS token, which a list row carries.
export const approveAlignment = (item: AlignmentListItem, pairs: GeorefPair[]) => apiPost<AlignmentItem>(`${BASE}/${item.id}/approve`, { edit_version: item.edit_version, pairs })
export const rejectAlignment = (item: AlignmentListItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/reject`, { edit_version: item.edit_version })
export const undoAlignmentApproval = (item: AlignmentListItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/undo`, { edit_version: item.edit_version })
export const retryAlignment = (item: AlignmentListItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/retry`, { edit_version: item.edit_version })
/** replace the revision's whole floor list; `fitPage` = the page the shared fit is measured on (default: floor 0) */
export const savePlanFloors = (item: AlignmentListItem, floors: PlanFloor[], fitPage?: number) =>
  apiPut<AlignmentItem>(`${BASE}/${item.id}/floors`, { edit_version: item.edit_version, floors, ...(fitPage != null ? { fit_page: fitPage } : {}) })
