// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReportSignature } from '../lib/reportSignature'
import { liveSignatures, printedSignatures, useSignatureLock } from './useReportSignatures'

const CLOSED = '2026-10-24T22:00:00.000Z'
const sig = (over: Partial<ReportSignature>): ReportSignature => ({
  id: 's1', role: 'el', name: 'Muster Hans', place: 'Oberwil', at: '2026-10-24T22:10:00.000Z',
  scope: 'a'.repeat(64), strokes: { w: 100, h: 40, d: [] }, ...over,
})

describe('liveSignatures', () => {
  it('drops a signature made before the latest close — it signed a Rapport since reopened', () => {
    const before = sig({ id: 'old', at: '2026-10-24T21:00:00.000Z' })
    const kdt = sig({ id: 'k', role: 'kdt', name: 'Kdt' })
    expect(liveSignatures([before, kdt], CLOSED)).toEqual({ kdt })
  })
  it('keeps the newest unvoided one per role', () => {
    const voided = sig({ id: 'v', at: '2026-10-24T23:00:00.000Z', voidedAt: '2026-10-24T23:05:00.000Z', voidReason: 'aendern' })
    const live = sig({ id: 'l' })
    expect(liveSignatures([live, voided], CLOSED)).toEqual({ el: live })
  })
})

describe('printedSignatures', () => {
  const live = { el: sig({}), kdt: sig({ id: 'k', role: 'kdt', name: 'Kdt' }) }
  it('prints the valid ones with «Ort, Datum» and a short checksum', () => {
    const out = printedSignatures(live, () => true, true)
    expect(out.map((p) => p.role)).toEqual(['el', 'kdt'])
    expect(out[0].name).toBe('Muster Hans')
    expect(out[0].placeDate).toMatch(/^Oberwil, \d{2}\.\d{2}\.\d{4}$/)
    expect(out[0].checksum.length).toBeLessThan(64)
  })
  it('leaves a signature that no longer holds off the paper — its line prints empty', () => {
    expect(printedSignatures(live, (r) => r === 'kdt', true).map((p) => p.role)).toEqual(['kdt'])
  })
  it('prints nothing on a running Einsatz', () => {
    expect(printedSignatures(live, () => true, false)).toEqual([])
  })
})

describe('useSignatureLock', () => {
  it('locks a closed Rapport while a signature holds, and lets go once the signed part changes', () => {
    const { result } = renderHook(() => useSignatureLock([sig({})], CLOSED, true))
    // hash not known yet: counted valid, so nothing flashes «ungültig»
    expect(result.current.signedLock).toBe(true)
    act(() => result.current.setScopeHash('a'.repeat(64)))
    expect(result.current.sigValid('el')).toBe(true)
    act(() => result.current.setScopeHash('b'.repeat(64)))
    expect(result.current.sigValid('el')).toBe(false)
    expect(result.current.signedLock).toBe(false)
  })
  it('never locks a running Einsatz', () => {
    expect(renderHook(() => useSignatureLock([sig({})], null, false)).result.current.signedLock).toBe(false)
  })
})
