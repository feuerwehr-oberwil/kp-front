// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
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

// owner call C2 (17.11.2026): the composer's text and the «Neuer Einsatz» wizard outlive a reload
// (iOS drops a backgrounded app); everything else stays memory-only. A «reload» here is a fresh
// module over the same sessionStorage.
describe('a draft across a reload', () => {
  afterEach(() => { sessionStorage.clear(); vi.resetModules() })
  const reload = () => { vi.resetModules(); return import('./draftKeep') }

  it('brings the composer text and the new-Einsatz wizard back – into the same Einsatz', async () => {
    const before = await reload()
    before.clearAllDrafts('inc-1')
    before.keepDraft('journal-entry', 'Treppenhaus geräumt')
    before.keepDraft('einsatz-wizard:new', { title: 'Brand' })
    before.keepDraft('journal-entry:rest', { photos: ['x'] })  // photos and clips: never
    before.keepDraft('mittel:inc-1', 'Schaum')                // the other forms: memory only
    const after = await reload()
    after.clearAllDrafts('inc-1')                             // IncidentWorkspace mounts again
    expect(after.readDraft('journal-entry', '')).toBe('Treppenhaus geräumt')
    expect(after.readDraft('einsatz-wizard:new', null)).toEqual({ title: 'Brand' })
    expect(after.readDraft('journal-entry:rest', null)).toBeNull()
    expect(after.readDraft('mittel:inc-1', '')).toBe('')
  })

  it('drops them where the memory copy goes: sent, another Einsatz, a switch in the same page', async () => {
    const m = await reload()
    m.clearAllDrafts('inc-1')
    m.keepDraft('journal-entry', 'gesendet')
    m.clearDraft('journal-entry')
    expect((await reload()).readDraft('journal-entry', '')).toBe('')

    const a = await reload()
    a.clearAllDrafts('inc-1')
    a.keepDraft('journal-entry', 'für Einsatz 1')
    const b = await reload()
    b.clearAllDrafts('inc-2')                                 // the reload landed elsewhere
    expect(b.readDraft('journal-entry', '')).toBe('')

    b.keepDraft('journal-entry', 'für Einsatz 2')
    b.clearAllDrafts('inc-2')                                 // a remount, no reload: as today
    expect(b.readDraft('journal-entry', '')).toBe('')
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
