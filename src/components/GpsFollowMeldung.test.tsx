// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { GpsFollowMeldung } from './GpsFollowMeldung'
import { Meldeleiste } from './Meldeleiste'
import { formatTime } from '../lib/format'
import type { GpsNotice } from '../lib/gpsReturn'
import type { Drawing } from '../types'

// D3 (24.09.2026): the row says HOW FAR the vehicle is, and the safe move — the line stays on
// site — is the green primary. ONE row per vehicle: two hoses on one TLF are named together. «Weiter
// folgen» tapped for a TLF already back at its depot is what drew the 1.15 km spike of 23.09.2026
// into the saved hose line.

afterEach(cleanup)

const AT = '2026-09-23T20:31:00.000Z'
const drawing = { id: 'hose', kind: 'line', lineNo: 1, coords: [[8, 47], [8.01, 47.01]] } as Drawing
const before = { coords: drawing.coords, routing: 'direct' as const, state: 'paused' as const, confirmedAt: drawing.coords[1], lastSafe: drawing.coords[1], at: AT }
const notice = (over: Partial<GpsNotice>): GpsNotice => ({
  key: 'gps-3:away', kind: 'away', vehicleId: 'gps-3', distanceM: 338, ends: [{ drawing, endpoint: 'end' }], canRevert: false, ...over,
})

function show(n: GpsNotice) {
  const on = { onKeep: vi.fn(), onRevert: vi.fn(), onFollow: vi.fn(), onDismiss: vi.fn() }
  const r = render(<><GpsFollowMeldung notice={n} label="TLF" {...on} /><Meldeleiste /></>)
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.ml-act button')]
  return { ...on, r, buttons, title: () => document.querySelector('.ml-title')?.textContent, sub: () => document.querySelector('.ml-sub')?.textContent, x: () => document.querySelector<HTMLButtonElement>('.ml-x') }
}

describe('GpsFollowMeldung', () => {
  it('away: names the vehicle, how far and the line, and leads with the green «Am Einsatzort lassen»', () => {
    const m = show(notice({}))
    expect(m.title()).toBe('TLF fährt weg · 340 m vom Einsatzort')
    expect(m.sub()).toBe('Leitung 1 endet noch am Einsatzort.')
    expect(m.buttons().map((b) => b.textContent)).toEqual(['Am Einsatzort lassen', 'Weiter folgen'])
    expect(m.buttons()[0].className).toBe('ml-btn prim go')
    expect(m.buttons()[1].className).toBe('ml-btn')
    expect(m.x()).toBeNull() // not something to wave away
    fireEvent.click(m.buttons()[0]); fireEvent.click(m.buttons()[1])
    expect(m.onKeep).toHaveBeenCalledOnce()
    expect(m.onFollow).toHaveBeenCalledOnce()
    expect(m.onRevert).not.toHaveBeenCalled()
  })

  it('two hoses on one TLF: ONE row naming both', () => {
    const m = show(notice({ ends: [{ drawing, endpoint: 'end' }, { drawing: { ...drawing, id: 'h2', lineNo: 2 }, endpoint: 'end' }] }))
    expect(document.querySelectorAll('.ml-row')).toHaveLength(1)
    expect(m.sub()).toBe('Leitung 1, Leitung 2 enden noch am Einsatzort.')
  })

  it('the distance updates live, in kilometres past one', () => {
    const m = show(notice({}))
    m.r.rerender(<><GpsFollowMeldung notice={notice({ distanceM: 1149 })} label="TLF" onKeep={m.onKeep} onRevert={m.onRevert} onFollow={m.onFollow} onDismiss={m.onDismiss} /><Meldeleiste /></>)
    expect(m.title()).toBe('TLF fährt weg · 1.1 km vom Einsatzort')
  })

  it('a vehicle out of the feed: no distance is invented', () => {
    expect(show(notice({ distanceM: undefined })).title()).toBe('TLF fährt weg')
  })

  it('stopped with the on-site line kept: «Zurück» is the primary, and the row may be waved away', () => {
    const m = show(notice({ key: 'gps-3:stopped', kind: 'stopped', distanceM: 1149, before, canRevert: true, ends: [{ drawing, endpoint: 'end', before }] }))
    expect(m.title()).toBe('TLF · 1.1 km vom Einsatzort')
    expect(m.sub()).toBe('Folgen gestoppt · Leitung 1 zeigt die Fahrt.')
    expect(m.buttons().map((b) => b.textContent)).toEqual(['Zurück auf Stand am Einsatzort', 'Weiter folgen'])
    fireEvent.click(m.buttons()[0])
    expect(m.onRevert).toHaveBeenCalledOnce()
    fireEvent.click(m.x()!)
    expect(m.onDismiss).toHaveBeenCalledOnce()
  })

  it('stopped with NOTHING kept (an older build\'s trace): «Hier lösen», never «Einsatzort», and not green', () => {
    const m = show(notice({ key: 'gps-3:stopped', kind: 'stopped', distanceM: 1149, canRevert: false }))
    expect(m.buttons().map((b) => b.textContent)).toEqual(['Hier lösen (Spur behalten)', 'Weiter folgen'])
    expect(m.buttons()[0].className).toBe('ml-btn prim')
    fireEvent.click(m.buttons()[0])
    expect(m.onKeep).toHaveBeenCalledOnce()
  })

  it('back on site while following: offers the way back once more', () => {
    const m = show(notice({ key: 'gps-3:back', kind: 'back', distanceM: 60, before, canRevert: true, ends: [{ drawing, endpoint: 'end', before }] }))
    expect(m.title()).toBe('TLF wieder am Einsatzort')
    expect(m.sub()).toBe(`Leitung 1 zeigt die Fahrt seit ${formatTime(new Date(AT))}.`)
    expect(m.buttons()[0].className).toBe('ml-btn prim go')
    fireEvent.click(m.buttons()[1])
    expect(m.onFollow).toHaveBeenCalledOnce()
  })
})
