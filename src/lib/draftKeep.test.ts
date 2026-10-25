// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeptState, clearDraft, clearAllDrafts, incidentSlot, keepDraft, readDraft, useIncidentSlot } from './draftKeep'

describe('a draft that survives its own component', () => {
  it('hands the value back after an unmount — the whole point', () => {
    const key = 'test:mittel:i1'
    const first = renderHook(() => useKeptState(key, ''))
    act(() => first.result.current[1]('Schlauch 40'))
    first.unmount()                                  // the operator jumps to the Verlauf
    const second = renderHook(() => useKeptState(key, ''))
    expect(second.result.current[0]).toBe('Schlauch 40')
    clearDraft(key)
  })

  it('starts empty once the form is submitted or abandoned', () => {
    const key = 'test:guest:i1'
    const first = renderHook(() => useKeptState(key, ''))
    act(() => first.result.current[1]('Muster Felix'))
    act(() => first.result.current[2]())             // clear() — submitted
    expect(first.result.current[0]).toBe('')
    first.unmount()
    expect(renderHook(() => useKeptState(key, '')).result.current[0]).toBe('')
  })

  // ⚠️ two Einsätze open in one session must not hand each other's half-typed entry back
  it('keeps two incidents apart', () => {
    keepDraft('mittel:a', 'Schaum')
    keepDraft('mittel:b', 'Ölbinder')
    expect(readDraft('mittel:a', '')).toBe('Schaum')
    expect(readDraft('mittel:b', '')).toBe('Ölbinder')
    clearDraft('mittel:a'); clearDraft('mittel:b')
  })

  it('is empty for a key nobody has written', () => {
    expect(readDraft('mittel:never', 'fallback')).toBe('fallback')
  })
})

describe('a per-Einsatz slot', () => {
  afterEach(() => sessionStorage.clear())

  it('hands back what was kept for this Einsatz, and nothing for another one', () => {
    const slot = incidentSlot<string>('test:tab')
    slot.write('a', 'plan')
    expect(slot.read('a')).toBe('plan')
    expect(slot.read('b')).toBeNull()
    // ONE slot: writing it for b replaces a's
    slot.write('b', 'bands')
    expect(slot.read('a')).toBeNull()
    slot.forget()
    expect(slot.read('b')).toBeNull()
  })

  it('outlives clearAllDrafts — the stamp keeps Einsätze apart, not the incident switch', () => {
    const slot = incidentSlot<number>('test:scroll')
    slot.write('a', 120)
    clearAllDrafts()
    expect(slot.read('a')).toBe(120)
    slot.forget()
  })

  it('in sessionStorage it survives a reload, and a broken entry reads as nothing', () => {
    incidentSlot<boolean>('test:present', 'session').write('a', true)
    // a reload: a fresh slot over the same key, no module memory involved
    expect(incidentSlot<boolean>('test:present', 'session').read('a')).toBe(true)
    sessionStorage.setItem('test:present', '{not json')
    expect(incidentSlot<boolean>('test:present', 'session').read('a')).toBeNull()
  })

  it('a falsy value is still a kept value — «Nur Anwesende» switched OFF stays off', () => {
    const slot = incidentSlot<boolean>('test:off', 'session')
    slot.write('a', false)
    expect(renderHook(() => useIncidentSlot(slot, 'a', true)).result.current[0]).toBe(false)
  })

  it('the hook writes every set through, so the next mount opens on it', () => {
    const slot = incidentSlot<string>('test:view', 'session')
    const first = renderHook(() => useIncidentSlot(slot, 'a', 'list'))
    expect(first.result.current[0]).toBe('list')
    act(() => first.result.current[1]('plan'))
    first.unmount()
    expect(renderHook(() => useIncidentSlot(slot, 'a', 'list')).result.current[0]).toBe('plan')
    expect(renderHook(() => useIncidentSlot(slot, 'b', 'list')).result.current[0]).toBe('list')
  })
})
