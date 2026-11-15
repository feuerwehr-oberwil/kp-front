// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { sha256Hex, type ReportSignature } from '../lib/reportSignature'
import { printedSignatures, signaturesToPrint, useSignatureLock } from './useReportSignatures'

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
  // SHA-256 is WebCrypto: it resolves on a later task, not a microtask
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  it('checks the signed part as it stands: an edit is never «valid» on an earlier hash', async () => {
    // the scope `sig` carries is the hash of this part
    const part = 'signed part'
    const live = { el: sig({ scope: await sha256Hex(part) }) }
    const { result, rerender } = renderHook(({ p }) => useSignatureLock(live, p, true), { initialProps: { p: part } })
    expect(result.current.sigState('el')).toBe('pending')
    await settle()
    expect(result.current).toMatchObject({ anyValid: true, signedLock: true })
    // same length, different content: pending at once, then «ungültig» – and nothing locked
    rerender({ p: 'signed Part' })
    expect(result.current.sigState('el')).toBe('pending')
    expect(result.current.signedLock).toBe(false)
    await settle()
    expect(result.current.sigState('el')).toBe('stale')
  })
  // owner, 14.11.2026: a signature is the current state, independent of open / closed
  it('a signature made while open holds through the close and a reopen – only the hash decides', async () => {
    const scoped = { el: sig({ scope: await sha256Hex('x') }) }
    const { result, rerender } = renderHook(({ closed }) => useSignatureLock(scoped, 'x', closed), { initialProps: { closed: false } })
    await settle()
    expect(result.current).toMatchObject({ anyValid: true, signedLock: false })
    rerender({ closed: true })
    expect(result.current).toMatchObject({ anyValid: true, signedLock: true })
    rerender({ closed: false })
    expect(result.current.sigState('el')).toBe('valid')
  })
  it('prints only what the content still matches, hashed at the moment of printing', async () => {
    const scoped = { el: sig({ scope: await sha256Hex('x') }) }
    expect((await signaturesToPrint(scoped, 'x')).map((p) => p.role)).toEqual(['el'])
    expect(await signaturesToPrint(scoped, 'y')).toEqual([])
    expect(await signaturesToPrint({}, 'x')).toEqual([])
  })
})
