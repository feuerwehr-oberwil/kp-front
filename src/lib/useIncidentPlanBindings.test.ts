// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useIncidentPlanBindings } from './useIncidentPlanBindings'
import { effectiveBindingGeoref, inheritPlanBinding, incidentGeorefForPlan, incidentGeorefKey, saveIncidentGeoref } from './incidentPlanBindings'
import { createUndoTimeline } from './undoTimeline'
import { georefDispatch, georefSnapshot, startGeorefMode } from './georefMode'

const initial = () => inheritPlanBinding({ id: 'sheet', objectId: 'house', planId: 'modul2', datasetId: 'pdf', planVersion: 1, title: 'Modul 2' }, {
  id: 11, aspect: 1.5, approved_at: '2026-09-09', pairs: [
    { plan: { x: 0, y: 0 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'auto' },
    { plan: { x: 1, y: 1 }, lngLat: { lng: 7.51, lat: 47.49 }, kind: 'auto' },
  ],
}, null, false)

describe('incident correction undo', () => {
  it('edits the workspace slice, publishes the fit, and restores it through shared undo/redo', () => {
    const history = createUndoTimeline()
    const key = incidentGeorefKey('incident', 'sheet')
    const hook = renderHook(() => {
      const [bindings, setBindings] = useState([initial()])
      useIncidentPlanBindings('incident', bindings, setBindings, false, history)
      return bindings
    })
    act(() => saveIncidentGeoref(key, { pairs: [] }))
    expect(effectiveBindingGeoref(hook.result.current[0]).pairs).toEqual([])
    expect(incidentGeorefForPlan(key)?.pairs).toEqual([])
    expect(history.canUndo()).toBe(true)
    act(() => startGeorefMode('modul2', 1.5, { storageKey: key }))
    act(() => { history.undo() })
    expect(georefSnapshot().planId).toBeNull()
    expect(hook.result.current[0].override).toBeUndefined()
    expect(incidentGeorefForPlan(key)?.pairs).toHaveLength(2)
    act(() => { history.redo() })
    expect(incidentGeorefForPlan(key)?.pairs).toEqual([])
    expect(hook.result.current[0].approvalId).toBe(11)
    hook.unmount()
    expect(() => saveIncidentGeoref(key, { pairs: [] })).toThrow('no longer available')
  })

  it('refuses read-only writes without recording an undo or mutating a binding', () => {
    const history = createUndoTimeline()
    const hook = renderHook(() => {
      const [bindings, setBindings] = useState([initial()])
      useIncidentPlanBindings('viewer', bindings, setBindings, true, history)
      return bindings
    })
    expect(() => saveIncidentGeoref(incidentGeorefKey('viewer', 'sheet'), { pairs: [] })).toThrow('read-only')
    expect(history.canUndo()).toBe(false)
    expect(hook.result.current[0].override).toBeUndefined()
    hook.unmount()
  })

  it('stages every drag frame immediately while keeping one undo step', () => {
    const history = createUndoTimeline()
    const key = incidentGeorefKey('drag', 'sheet')
    const hook = renderHook(() => {
      const [bindings, setBindings] = useState([initial()])
      useIncidentPlanBindings('drag', bindings, setBindings, false, history)
      return bindings
    })
    const first = initial().georef
    first.pairs[0].plan.x = 0.2
    const last = initial().georef
    last.pairs[0].plan.x = 0.3
    act(() => saveIncidentGeoref(key, first, true))
    expect(effectiveBindingGeoref(hook.result.current[0]).pairs[0].plan.x).toBe(0.2)
    act(() => saveIncidentGeoref(key, last, true))
    expect(effectiveBindingGeoref(hook.result.current[0]).pairs[0].plan.x).toBe(0.3)
    act(() => { history.undo() })
    expect(history.canUndo()).toBe(false)
    expect(effectiveBindingGeoref(hook.result.current[0]).pairs[0].plan.x).toBe(0)
    act(() => { history.redo() })
    expect(effectiveBindingGeoref(hook.result.current[0]).pairs[0].plan.x).toBe(0.3)
    hook.unmount()
  })

  it('saves pairing-mode edits without waiting for the station debounce timer', () => {
    const history = createUndoTimeline()
    const key = incidentGeorefKey('immediate', 'sheet')
    const hook = renderHook(() => {
      const [bindings, setBindings] = useState([initial()])
      useIncidentPlanBindings('immediate', bindings, setBindings, false, history)
      return bindings
    })
    act(() => startGeorefMode('modul2', 1.5, { storageKey: key }))
    act(() => georefDispatch({ type: 'clear' }))
    expect(hook.result.current[0].override?.pairs).toEqual([])
    act(() => georefDispatch({ type: 'dismiss' }))
    hook.unmount()
  })
})
