import { describe, expect, it, vi } from 'vitest'
import { addPlanBindings, effectiveBindingGeoref, incidentBindingApproved, inheritPlanBinding, incidentGeorefForPlan, incidentGeorefKey, isIncidentPlanBinding, overridePlanBinding, registerIncidentPlanBindings, saveIncidentGeoref } from './incidentPlanBindings'
import { mergeWorkspace } from './mergeWorkspace'
import { deriveInitial, sanitizeWorkspace } from './workspace'
import { boardTwinAnnosForPrint, georefPlans, planAspect } from './georefTwins'
import type { GeorefPair } from './georef'
import { georefForPlan } from './stationPlanScale'
import { referenceUrl } from './api/reference'
import { buildDirectReportPayload } from './reportPdfDirect'
import { defaultReportOptions } from './report'
import type { PlanDocument } from '../types'

const pairs: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'auto' },
  { plan: { x: 1, y: 1 }, lngLat: { lng: 7.501, lat: 47.499 }, kind: 'auto' },
]
const sheet = { id: 'object:house:plan:modul2', objectId: 'house', planId: 'modul2', datasetId: 'pdf:house:2', planVersion: 3, title: 'Modul 2' }
const approval = { id: 11, pairs, aspect: 1.6, approved_at: '2026-09-09T12:00:00Z' }
const binding = () => inheritPlanBinding(sheet, approval, null, false)

describe('incident plan snapshots', () => {
  it('inherits approval without turning auto pairs into measured evidence or sharing mutable objects', () => {
    const inherited = binding()
    expect(inherited).toMatchObject({ planVersion: 3, source: 'approved', approvalId: 11, aspect: 1.6 })
    expect(inherited.georef.pairs.map((pair) => pair.kind)).toEqual(['auto', 'auto'])
    inherited.georef.pairs[0].plan.x = 0.4
    expect(approval.pairs[0].plan.x).toBe(0)
  })

  it('retains the original bytes and fit when a station publishes a newer revision', () => {
    const existing = [binding()]
    const updated = inheritPlanBinding({ ...sheet, planVersion: 4 }, { ...approval, id: 12, aspect: 2 }, null, false)
    expect(addPlanBindings(existing, [updated])).toBe(existing)
    expect(existing[0].approvalId).toBe(11)
  })

  it('records the exact approval event when a proposal has been published more than once', () => {
    expect(inheritPlanBinding(sheet, { ...approval, approval_id: 32 }, null, false).approvalId).toBe(32)
  })

  it('keeps the first server binding when two devices first open across a revision change', () => {
    const first = binding()
    const later = inheritPlanBinding({ ...sheet, planVersion: 4 }, { ...approval, approval_id: 32 }, null, false)
    const [correctedLater] = overridePlanBinding([later], later.id, { pairs: [] })
    const merged = mergeWorkspace({}, { planBindings: [correctedLater] }, { planBindings: [first] })
    expect(merged.planBindings).toEqual([{ ...first, override: undefined }])
  })

  it('merges explicit corrections and undo only against the unchanged bound revision', () => {
    const original = binding()
    const corrected = overridePlanBinding([original], original.id, { pairs: [] })
    expect(mergeWorkspace({ planBindings: [original] }, { planBindings: corrected }, { planBindings: [original] }).planBindings).toEqual(corrected)
    expect(mergeWorkspace({ planBindings: corrected }, { planBindings: [original] }, { planBindings: corrected }).planBindings).toEqual([{ ...original, override: undefined }])
  })

  it('preserves a legacy fit under existing annotations without inventing approval', () => {
    const legacy = { pairs: pairs.map((pair) => ({ ...pair, kind: 'gesetzt' as const })) }
    const inherited = inheritPlanBinding(sheet, approval, legacy, true)
    expect(inherited.source).toBe('legacy')
    expect(inherited.approvalId).toBeUndefined()
    expect(inherited.georef).toEqual(legacy)
    expect(inheritPlanBinding(sheet, approval, legacy, false).source).toBe('approved')
  })

  it('keeps a deliberate disconnect as an override without falling back to approval', () => {
    const original = binding()
    const [changed] = overridePlanBinding([original], original.id, { pairs: [] })
    expect(effectiveBindingGeoref(changed).pairs).toEqual([])
    expect(changed.georef).toEqual(original.georef)
    expect(original.override).toBeUndefined()
  })

  it('survives JSON cache hydration and merges alongside another workspace domain', () => {
    const original = binding()
    const offline = sanitizeWorkspace(JSON.parse(JSON.stringify({ planBindings: [original] }))).ws
    expect(offline?.planBindings).toEqual([original])
    expect(deriveInitial(offline, 'incident', {}).planBindings).toEqual([original])
    const base = { planBindings: [original], entities: [] }
    const changed = overridePlanBinding([original], original.id, { pairs: [] })
    expect(mergeWorkspace(base, { ...base, planBindings: changed }, { ...base, entities: [{ id: 'new-symbol' }] })).toMatchObject({
      planBindings: changed, entities: [{ id: 'new-symbol' }],
    })
  })

  it('routes edits to the right incident and rejects late writes after unmount', () => {
    const one = vi.fn(), two = vi.fn()
    const unregisterOne = registerIncidentPlanBindings('one', { bindings: [binding()], save: one })
    const unregisterTwo = registerIncidentPlanBindings('two', { bindings: [binding()], save: two })
    const key = incidentGeorefKey('one', sheet.id)
    expect(incidentGeorefForPlan(key)?.pairs).toEqual(pairs)
    saveIncidentGeoref(key, { pairs: [] })
    expect(one).toHaveBeenCalledWith(sheet.id, { pairs: [] }, undefined)
    expect(two).not.toHaveBeenCalled()
    unregisterOne()
    expect(() => saveIncidentGeoref(key, { pairs })).toThrow('no longer available')
    expect(incidentGeorefForPlan(key)).toBeNull()
    unregisterTwo()
  })

  it('names a station approval only while it still carries the sheet', () => {
    const approved = { ...binding(), source: 'approved' as const }
    const unregister = registerIncidentPlanBindings('one', { bindings: [approved, { ...binding(), id: 'other', source: 'none' as const }], save: vi.fn() })
    expect(incidentBindingApproved(incidentGeorefKey('one', sheet.id))).toBe(true)
    expect(incidentBindingApproved(incidentGeorefKey('one', 'other'))).toBe(false)
    expect(incidentBindingApproved(incidentGeorefKey('two', sheet.id))).toBe(false)
    approved.override = { pairs: [] } // the operator overrode it – no longer the station's fit
    expect(incidentBindingApproved(incidentGeorefKey('one', sheet.id))).toBe(false)
    unregister()
  })

  it('uses the approved PDF aspect rather than a later station calibration aspect', () => {
    expect(planAspect({ id: 'modul2', orientation: 'landscape', georefAspect: 1.6 }, {
      default: { ar: 2, refM: 10, mPerU: 100 }, byPlan: {}, georefByPlan: {},
    })).toBe(1.6)
  })

  it('prints the pinned PDF URL and projects map content with the incident fit and aspect', () => {
    const pinned = binding()
    const unregister = registerIncidentPlanBindings('print', { bindings: [pinned], save: vi.fn() })
    try {
      const document: PlanDocument = {
        id: pinned.planId, code: 'Modul 2', title: pinned.title, subtitle: '', orientation: 'landscape',
        imageUrl: referenceUrl(pinned.datasetId, pinned.planVersion),
        georefKey: incidentGeorefKey('print', pinned.id), georefAspect: pinned.aspect,
      }
      const [linked] = georefPlans([document], georefForPlan, (plan) => planAspect(plan, {
        default: { ar: 9, refM: 20, mPerU: 300 }, byPlan: {},
        georefByPlan: { [pinned.id]: { pairs: [] } },
      }))
      const point = linked.fit.toMap({ x: 0.25, y: 0.4 })
      const twins = boardTwinAnnosForPrint(linked, [{
        id: 'note', kind: 'note', layer: 'taktisch', coord: [point.lng, point.lat], label: 'Zugang',
      }], [])
      expect(twins).toHaveLength(1)
      expect(twins[0].x).toBeCloseTo(0.25)
      expect(twins[0].y).toBeCloseTo(0.4)
      const timestamp = '2026-09-09T12:00:00Z'
      const payload = buildDirectReportPayload({
        incident: {
          id: 'print', title: 'Übung', divera_id: null, type: null, priority: null, address: null,
          lat: null, lng: null, status: 'offen', source: 'manual', source_ref: null,
          auto_opened: false, started_at: timestamp, closed_at: null, is_archived: false,
          is_exercise: true, report_done_at: null, workspace_rev: 1, created_by: null,
          created_at: timestamp, updated_at: timestamp,
        },
        draft: { meta: {}, generatedAt: timestamp, proof: { intact: null, checkedAt: timestamp }, options: { ...defaultReportOptions, annotatedPlans: true } },
        trupps: [], attendance: {}, events: [], plans: [document], board: {}, twinAnnos: { [pinned.planId]: twins },
      })
      expect(payload.planPages).toMatchObject([{ url: '/api/reference/pdf%3Ahouse%3A2?v=3', annos: [{ text: 'Zugang' }] }])
    } finally { unregister() }
  })
})

describe('floor packs freeze with the revision', () => {
  const floors = [{ page: 0, index: -1, name: null }, { page: 1, index: 0, name: 'EG / ZWG' }]
  it('copies the published floors onto the binding and refuses malformed ones on load', () => {
    const bound = inheritPlanBinding(sheet, approval, null, false, floors)
    expect(bound.floors).toEqual(floors)
    expect(bound.floors).not.toBe(floors)
    expect(inheritPlanBinding(sheet, approval, null, false, []).floors).toBeUndefined()
    expect(isIncidentPlanBinding(bound)).toBe(true)
    expect(isIncidentPlanBinding({ ...bound, floors: [{ page: 1, index: 0.5, name: null }] })).toBe(false)
    expect(isIncidentPlanBinding({ ...bound, floors: undefined })).toBe(true)
  })
})


it('freezes the approved fit page instead of silently using page zero', () => {
  expect(inheritPlanBinding(sheet, { ...approval, page: 2 }, null, false).page).toBe(2)
})
