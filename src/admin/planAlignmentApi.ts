import { apiGet, apiGetRaw, apiPost } from '../lib/api'
import type { GeoPt, GeorefPair } from '../lib/georef'

export type AlignmentStatus = 'pending' | 'processing' | 'ready' | 'needs_review' | 'no_match' | 'failed' | 'unavailable' | 'unsupported' | 'approved' | 'rejected'

export interface AlignmentItem {
  id: number
  dataset_id: string
  plan_version: number
  page: number
  page_count: number | null
  can_approve: boolean
  object_name: string
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
  reference_rings: GeoPt[][]
  reference_source: string | null
  reference_at: string | null
}

export interface AlignmentQueue {
  items: AlignmentItem[]
  capability: { available: boolean; reason: string | null }
}

const BASE = '/api/admin/plan-alignments'
export const loadAlignmentQueue = (summary = false) => apiGet<AlignmentQueue>(`${BASE}${summary ? '?summary=true' : ''}`)
export const loadAlignmentDetail = (id: number) => apiGet<AlignmentItem>(`${BASE}/${id}`)
export const alignmentPreview = (id: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview`, { signal }).then(r => r.blob())
/** the review grid's small JPEG of the same page (the exact raster stays behind `alignmentPreview`) */
export const alignmentThumbnail = (id: number, signal: AbortSignal) => apiGetRaw(`${BASE}/${id}/preview?thumbnail=true`, { signal }).then(r => r.blob())
export const approveAlignment = (item: AlignmentItem, pairs: GeorefPair[]) => apiPost<AlignmentItem>(`${BASE}/${item.id}/approve`, { edit_version: item.edit_version, pairs })
export const rejectAlignment = (item: AlignmentItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/reject`, { edit_version: item.edit_version })
export const undoAlignmentApproval = (item: AlignmentItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/undo`, { edit_version: item.edit_version })
export const retryAlignment = (item: AlignmentItem) => apiPost<AlignmentItem>(`${BASE}/${item.id}/retry`, { edit_version: item.edit_version })
