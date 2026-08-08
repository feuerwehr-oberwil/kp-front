// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeptState, clearDraft, keepDraft, readDraft } from './draftKeep'

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
