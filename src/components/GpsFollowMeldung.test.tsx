// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { GpsFollowMeldung } from './GpsFollowMeldung'
import { Meldeleiste } from './Meldeleiste'
import { formatTime } from '../lib/format'
import type { GpsNotice } from '../lib/gpsReturn'
import type { Drawing } from '../types'

// D3 (24.09.2026): the row says HOW FAR the vehicle is, and the safe move — the line stays on
// site — is the green primary. «Weiter folgen» tapped for a TLF already back at the Magazin is
// what drew the 1.15 km spike of 23.09.2026 into the saved hose line.

afterEach(cleanup)

const AT = '2026-09-23T20:31:00.000Z'
const drawing = { id: 'hose', kind: 'line', coords: [[7.5, 47.5], [7.51, 47.51]] } as Drawing
const before = { coords: drawing.coords, routing: 'direct' as const, state: 'paused' as const, confirmedAt: drawing.coords[1], lastSafe: drawing.coords[1], at: AT }
const notice = (over: Partial<GpsNotice>): GpsNotice => ({ key: 'hose:end', drawing, endpoint: 'end', kind: 'away', distanceM: 338, ...over })

function show(n: GpsNotice) {
  const on = { onKeep: vi.fn(), onRevert: vi.fn(), onFollow: vi.fn() }
  const r = render(<><GpsFollowMeldung notice={n} label="TLF" {...on} /><Meldeleiste /></>)
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.ml-act button')]
  return { ...on, r, buttons, title: () => document.querySelector('.ml-title')?.textContent, sub: () => document.querySelector('.ml-sub')?.textContent }
}

describe('GpsFollowMeldung', () => {
  it('away: names the vehicle and how far, and leads with the green «Am Einsatzort lassen»', () => {
    const m = show(notice({}))
    expect(m.title()).toBe('TLF fährt weg · 340 m vom Einsatzort')
    expect(m.sub()).toBe('Die Leitung endet noch am Einsatzort.')
    expect(m.buttons().map((b) => b.textContent)).toEqual(['Am Einsatzort lassen', 'Weiter folgen'])
    expect(m.buttons()[0].className).toBe('ml-btn prim go')
    expect(m.buttons()[1].className).toBe('ml-btn')
    fireEvent.click(m.buttons()[0]); fireEvent.click(m.buttons()[1])
    expect(m.onKeep).toHaveBeenCalledOnce()
    expect(m.onFollow).toHaveBeenCalledOnce()
    expect(m.onRevert).not.toHaveBeenCalled()
  })

  it('the distance updates live, in kilometres past one', () => {
    const m = show(notice({}))
    m.r.rerender(<><GpsFollowMeldung notice={notice({ distanceM: 1149 })} label="TLF" onKeep={m.onKeep} onRevert={m.onRevert} onFollow={m.onFollow} /><Meldeleiste /></>)
    expect(m.title()).toBe('TLF fährt weg · 1.1 km vom Einsatzort')
  })

  it('a vehicle out of the feed: no distance is invented', () => {
    expect(show(notice({ distanceM: undefined })).title()).toBe('TLF fährt weg')
  })

  it('stopped: the way back is the primary', () => {
    const m = show(notice({ kind: 'stopped', distanceM: 1149, before }))
    expect(m.title()).toBe('TLF · 1.1 km vom Einsatzort')
    expect(m.sub()).toBe('Folgen gestoppt · die Leitung zeigt die Fahrt.')
    expect(m.buttons().map((b) => b.textContent)).toEqual(['Zurück auf Stand am Einsatzort', 'Weiter folgen'])
    fireEvent.click(m.buttons()[0])
    expect(m.onRevert).toHaveBeenCalledOnce()
  })

  it('back on site while following: offers the way back once more', () => {
    const m = show(notice({ kind: 'back', distanceM: 60, before }))
    expect(m.title()).toBe('TLF wieder am Einsatzort')
    expect(m.sub()).toBe(`Die Leitung zeigt die Fahrt seit ${formatTime(new Date(AT))}.`)
    expect(m.buttons()[0].className).toBe('ml-btn prim go')
    fireEvent.click(m.buttons()[1])
    expect(m.onFollow).toHaveBeenCalledOnce()
  })
})
