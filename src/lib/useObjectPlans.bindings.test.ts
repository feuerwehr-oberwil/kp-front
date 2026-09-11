// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasLegacyAlignmentContext, inheritPlanBinding, type IncidentPlanBinding } from './incidentPlanBindings'
import { sanitizeWorkspace } from './workspace'
import { useObjectPlans } from './useObjectPlans'
import type { ObjectWithPlans } from './api/objects'
import type { LngLat } from '../types'

const { near, metadata, legacy, onBind } = vi.hoisted(() => ({ near: vi.fn(), metadata: vi.fn(), legacy: vi.fn(), onBind: vi.fn() }))
vi.mock('./incidents', () => ({
  objectsNearIncidentResilient: near, getObjectResilient: vi.fn(),
  referenceUrl: (id: string, version: number) => `/api/reference/${encodeURIComponent(id)}?v=${version}`,
}))
vi.mock('./api/reference', () => ({ getApprovedPlanAlignments: metadata }))
vi.mock('./stationPlanScale', () => ({ georefForPlan: legacy }))

const center: LngLat = [7.5, 47.5]
const noBindings: IncidentPlanBinding[] = []
const noop = () => {}
const knownLegacy = { pairs: [
  { plan: { x: 0, y: 0 }, lngLat: { lng: 7.5, lat: 47.5 } },
  { plan: { x: 1, y: 1 }, lngLat: { lng: 7.51, lat: 47.49 } },
] }
const object: ObjectWithPlans = {
  id: 'house', name: 'House', address: null, lat: 47.5, lng: 7.5, source_note: null,
  updated_at: '2026-09-09', distance_m: 0,
  plans: [{
    id: 'plan:house:modul2', object_id: 'house', module: 'modul2', kind: 'pdf', title: 'Modul 2',
    source_type: 'upload', source_note: null, content_type: 'application/pdf', size_bytes: 100,
    feature_count: null, current_version: 4, updated_at: '2026-09-09',
  }],
}
beforeEach(() => { vi.clearAllMocks(); near.mockResolvedValue([object]); legacy.mockReturnValue(null) })

describe('object plans bind before field use', () => {
  it('preserves annotated legacy alignment offline without waiting for approval metadata', async () => {
    legacy.mockReturnValue(knownLegacy)
    metadata.mockRejectedValue(new Error('offline'))
    const legacyPlanIds = new Set(['modul2'])
    const hook = renderHook(() => useObjectPlans('incident', center, noop, undefined, noop, { bindings: noBindings, onBind, legacyPlanIds }))
    await waitFor(() => expect(onBind).toHaveBeenCalled())
    expect(hook.result.current.effectiveBindings[0]).toMatchObject({ planVersion: 4, source: 'legacy', georef: knownLegacy })
    expect(hook.result.current.effectiveBindings[0].approvalId).toBeUndefined()
    expect(metadata).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('keeps the bound PDF when the object catalogue serves a replacement revision', async () => {
    const bindings = [inheritPlanBinding({
      id: 'object:house:plan:modul2', objectId: 'house', planId: 'modul2',
      datasetId: 'plan:house:modul2', planVersion: 3, title: 'Modul 2',
    }, { id: 1, aspect: 1.6, approved_at: '2026-09-08', pairs: knownLegacy.pairs }, null, false)]
    const legacyPlanIds = new Set<string>()
    const hook = renderHook(() => useObjectPlans('incident', center, noop, undefined, noop, { bindings, onBind, legacyPlanIds }))
    await waitFor(() => expect(hook.result.current.resolvedPlanDocs.some((plan) => plan.id === 'modul2')).toBe(true))
    const plan = hook.result.current.resolvedPlanDocs.find((candidate) => candidate.id === 'modul2')
    expect(plan).toMatchObject({ imageUrl: '/api/reference/plan%3Ahouse%3Amodul2?v=3', georefAspect: 1.6 })
    expect(metadata).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('preserves a map-only existing picture while a pristine incident remains approved-first', async () => {
    const existing = sanitizeWorkspace({ entities: [{ id: 'note', kind: 'note', layer: 'taktisch', coord: center, label: 'Zugang' }], drawings: [] }).ws
    expect(hasLegacyAlignmentContext(existing)).toBe(true)
    expect(hasLegacyAlignmentContext(sanitizeWorkspace({ entities: [], drawings: [] }).ws)).toBe(false)
    legacy.mockReturnValue(knownLegacy)
    const legacyPlanIds = new Set<string>()
    const hook = renderHook(() => useObjectPlans('incident', center, noop, undefined, noop, {
      bindings: noBindings, onBind, legacyPlanIds, preserveLegacy: hasLegacyAlignmentContext(existing),
    }))
    await waitFor(() => expect(onBind).toHaveBeenCalled())
    expect(hook.result.current.effectiveBindings[0].source).toBe('legacy')
    expect(metadata).not.toHaveBeenCalled()
    hook.unmount()
  })
})
