// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReportSignature } from '../lib/reportSignature'
import { printedSignatures, useSignatureLock } from './useReportSignatures'

const sig = (over: Partial<ReportSignature>): ReportSignature => ({
  id: 's1', role: 'el', name: 'Muster Hans', place: 'Oberwil', at: '2026-10-24T22:10:00.000Z',
  scope: 'a'.repeat(64), strokes: { w: 100, h: 40, d: [] }, ...over,
})

describe('printedSignatures', () => {
  const live = { el: sig({}), kdt: sig({ id: 'k', role: 'kdt', name: 'Kdt' }) }
  it('prints the valid ones with «Ort, Datum» and a short checksum', () => {
    const out = printedSignatures(live, () => true)
    expect(out.map((p) => p.role)).toEqual(['el', 'kdt'])
    expect(out[0].name).toBe('Muster Hans')
    expect(out[0].placeDate).toMatch(/^Oberwil, \d{2}\.\d{2}\.\d{4}$/)
    expect(out[0].checksum.length).toBeLessThan(64)
  })
  it('leaves a signature that no longer holds off the paper — its line prints empty', () => {
    expect(printedSignatures(live, (r) => r === 'kdt').map((p) => p.role)).toEqual(['kdt'])
  })
})

describe('useSignatureLock', () => {
  it('locks a closed Rapport while a signature holds, and lets go once the signed part changes', () => {
    const { result } = renderHook(() => useSignatureLock([sig({})], true))
    // hash not known yet: counted valid, so nothing flashes «ungültig»
    expect(result.current.signedLock).toBe(true)
    act(() => result.current.setScopeHash('a'.repeat(64)))
    expect(result.current.sigValid('el')).toBe(true)
    act(() => result.current.setScopeHash('b'.repeat(64)))
    expect(result.current.sigValid('el')).toBe(false)
    expect(result.current.signedLock).toBe(false)
  })
  // owner, 14.11.2026: a signature is the current state, independent of open / closed
  it('a signature made while open holds through the close and a reopen – only the hash decides', () => {
    const { result, rerender } = renderHook(({ closed }) => useSignatureLock([sig({})], closed), { initialProps: { closed: false } })
    act(() => result.current.setScopeHash('a'.repeat(64)))
    expect(result.current).toMatchObject({ anyValid: true, signedLock: false })
    rerender({ closed: true })
    expect(result.current).toMatchObject({ anyValid: true, signedLock: true })
    rerender({ closed: false })
    expect(result.current.sigValid('el')).toBe(true)
    // an edit on the reopened Rapport: «ungültig»
    act(() => result.current.setScopeHash('b'.repeat(64)))
    expect(result.current.sigValid('el')).toBe(false)
  })
})
