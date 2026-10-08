// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { findPlakat, isPlakatData, newPlakat, nextTrend, plakatAnno, plakatForPdf, plakatHasContent, putRow } from './plakat'
import { plakatSeedFrom } from './plakatSeed'
import { isBoardAnno, sanitizeWorkspace } from './workspace'
import { objectsFromLegacy, viewsOf } from './tacticalObjects'
import { useBoardDoc, type BoardHistory } from '../components/useBoardDoc'
import type { BoardAnno, Entity } from '../types'

const ABS = ['Standort Einsatzleitung', 'Warteraum']
const seed = { title: 'Zimmerbrand', address: 'Schlossgasse 9', alarm: '11:24', einsatzleiter: 'Oblt Meier', wind: 'Wind aus W 14 km/h', vehicles: ['TLF 1', 'tlf 1', ' ADL ', ''] }

describe('«Erstes Plakat (FKS)» — the pre-fill', () => {
  it('fills the header, the vehicles (once each), the wind as a suggestion and the Absprachepunkte — nothing else', () => {
    const d = newPlakat(seed, ABS, 'Wetter')
    expect([d.title, d.address, d.alarm, d.el]).toEqual(['Zimmerbrand', 'Schlossgasse 9', '11:24', 'Oblt Meier'])
    expect(d.mittel.map((r) => r.formation)).toEqual(['TLF 1', 'ADL'])
    expect(d.spezial).toEqual([expect.objectContaining({ text: 'Wind aus W 14 km/h', note: 'Wetter', trend: 'same' })])
    expect(d.absprachen.map((r) => [r.text, !!r.done])).toEqual([['Standort Einsatzleitung', false], ['Warteraum', false]])
    expect([d.front, d.ordnung, d.sanitaet, d.massnahmen, d.verbindungen]).toEqual([[], [], [], [], []])
    expect(plakatHasContent(d)).toBe(false)
  })
  it('without a weather reading there is no Spezialproblem', () => {
    expect(newPlakat({ title: 'X' }, [], 'Wetter').spezial).toEqual([])
  })
  it('reads the seed from what the workspace holds', () => {
    const s = plakatSeedFrom({
      title: 'Zimmerbrand', address: 'Schlossgasse 9', alarmIso: '2026-10-08T09:24:00Z', einsatzleiter: 'Oblt Meier',
      weather: { wind_dir_deg: 270, wind_speed_kmh: 13.6, wind_gust_kmh: null, temp_c: 14, precip_mm: 0, weather_code: 3, observed_at: null, source: 'x', station: null },
      fahrzeuge: [{ id: 'tlf', ausgerueckt: '2026-10-08T09:27:00Z' }, { id: 'mtf' }],
      fleet: [{ id: 'tlf', label: 'TLF 1' }, { id: 'mtf', label: 'MTF' }],
      entities: [{ id: 'v', kind: 'vehicle', coord: [7.5, 47.5], label: 'ADL' } as Entity],
    })
    expect(s.wind).toMatch(/W 14 km\/h$/)
    expect(s.alarm).toMatch(/^\d\d:\d\d$/)
    expect(s.vehicles).toEqual(['TLF 1', 'ADL']) // the MTF never went out
  })
})

describe('«Erstes Plakat» — the rows', () => {
  const d = newPlakat(seed, ABS, 'Wetter')
  it('the trailing new row becomes a row on its first text; clearing a row removes it', () => {
    const a = putRow(d, 'front', 'r1', { text: 'Person vermisst 1. OG' })
    expect(a.front).toEqual([{ id: 'r1', text: 'Person vermisst 1. OG' }])
    expect(putRow(a, 'front', 'r1', { trend: 'up' }).front[0].trend).toBe('up')
    expect(putRow(a, 'front', 'r1', { text: '' }).front).toEqual([])
    expect(plakatHasContent(a)).toBe(true)
  })
  it('a no-op hands back the same object, and a blank new row writes nothing', () => {
    const a = putRow(d, 'massnahmen', 'm1', { was: 'Riegel Seite C', wer: 'TLF 1' })
    expect(putRow(a, 'massnahmen', 'm1', { was: 'Riegel Seite C' })).toBe(a)
    expect(putRow(d, 'massnahmen', 'm2', { was: '  ' })).toBe(d)
  })
  it('the trend cycles ➚ = ➘ and back to open', () => {
    expect([nextTrend(undefined), nextTrend('up'), nextTrend('same'), nextTrend('down')]).toEqual(['up', 'same', 'down', undefined])
  })
  it('prints what is on it', () => {
    const pdf = plakatForPdf(putRow(d, 'front', 'r1', { text: 'Rauch', trend: 'up' }), { up: '➚', same: '=', down: '➘' })
    expect(pdf.front).toEqual([{ text: 'Rauch', note: '', trend: '➚' }])
    expect(pdf.title).toBe('Zimmerbrand')
  })
})

describe('«Erstes Plakat» — insert, undo, persist', () => {
  it('is ONE board anno: inserting it is one ↶ step, an edit another, and ↶ ↶ leaves the empty sheet', () => {
    const laid: string[] = []
    const { result } = renderHook(() => {
      const [annos, setAnnos] = useState<BoardAnno[]>([])
      const [hist, setHist] = useState<BoardHistory>({})
      const doc = useBoardDoc({
        annos, onChange: setAnnos, emit: vi.fn(), activeId: 'tafel', onCheckpoint: (_p, s) => laid.push(s),
        hist, setHist, selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
      })
      return { doc, annos }
    })
    const anno = plakatAnno(newPlakat(seed, ABS, 'Wetter'))
    act(() => result.current.doc.add(anno))
    expect(findPlakat(result.current.annos)?.id).toBe(anno.id)
    act(() => result.current.doc.patchCommit(anno.id, { plakat: putRow(anno.plakat!, 'front', 'r1', { text: 'Rauch' }) }))
    expect(findPlakat(result.current.annos)?.plakat.front).toHaveLength(1)
    expect(laid).toHaveLength(2)
    act(() => { result.current.doc.undo() })
    expect(findPlakat(result.current.annos)?.plakat.front).toEqual([])
    act(() => { result.current.doc.undo() })
    expect(result.current.annos).toEqual([])
    act(() => { result.current.doc.redo() })
    expect(findPlakat(result.current.annos)?.id).toBe(anno.id)
  })

  it('survives the save → load gate and the object store, fields and all', () => {
    const anno = plakatAnno(putRow(newPlakat(seed, ABS, 'Wetter'), 'massnahmen', 'm1', { was: 'Personensuche', wer: 'AS Schmid', wann: '11:31' }))
    expect(isBoardAnno(anno)).toBe(true)
    // the object store is what persists the board (lib/tacticalObjects); its board view gives it back
    const objects = objectsFromLegacy([], [], { tafel: [anno] })
    expect(viewsOf(objects).board.tafel).toEqual([anno])
    // …and a reload passes the blob through the sanitizer
    const blob = JSON.parse(JSON.stringify({ board: { tafel: [anno] }, objects }))
    const g = sanitizeWorkspace(blob)
    expect(g.dropped).toBe(0)
    expect(g.ws?.board?.tafel).toEqual([anno])
  })

  it('a malformed poster is dropped at the gate, never rendered half', () => {
    expect(isPlakatData({ title: 'x', address: '', alarm: '', el: '' })).toBe(false)
    expect(isBoardAnno({ id: 'pk1', kind: 'plakat', plakat: { title: 1 } })).toBe(false)
    expect(isBoardAnno({ id: 'pk1', kind: 'plakat' })).toBe(false)
  })
})

describe('«Erstes Plakat» in the Rapport', () => {
  it('rides the report payload only when the Tafel carries one, trends as words', async () => {
    const { plakatPayload } = await import('./reportPdfDirect')
    expect(plakatPayload({ tafel: [] })).toBeUndefined()
    expect(plakatPayload(undefined)).toBeUndefined()
    const anno = plakatAnno(putRow(newPlakat(seed, ABS, 'Wetter'), 'front', 'r1', { text: 'Rauch', trend: 'up' }))
    const out = plakatPayload({ tafel: [anno] }) as { front: { trend: string }[] }
    expect(out.front[0].trend).toBe('wird schlimmer')
  })
})
