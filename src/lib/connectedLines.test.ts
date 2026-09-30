import { describe, expect, it } from 'vitest'
import { connectedLineLabel } from './connectedLines'
import type { LineAttachment, LngLat } from '../types'

// «Verbundene Linien» (sweep K11, 29.09.2026): two rows «Linie ›» «Linie ›» could not be told apart
const to = (id: string): LineAttachment => ({ target: { kind: 'object', id }, routing: 'direct' })
// ~42 m due north at 47°N
const coords: LngLat[] = [[8, 47], [8, 47.000378]]
const names: Record<string, string> = { tlf: 'TLF', h142: 'Hydrant H-142' }
const nameOf = (id: string) => names[id]

describe('connectedLineLabel', () => {
  it('names a plain line by its length and its far end', () => {
    expect(connectedLineLabel({ coords, startAttachment: to('tlf'), endAttachment: to('h142') }, 'tlf', nameOf))
      .toBe('Linie · 42 m → Hydrant H-142')
    // …from whichever end the panel is
    expect(connectedLineLabel({ coords, startAttachment: to('tlf'), endAttachment: to('h142') }, 'h142', nameOf))
      .toBe('Linie · 42 m → TLF')
  })

  it('says only the length when the far end is loose or nameless', () => {
    expect(connectedLineLabel({ coords, startAttachment: to('tlf') }, 'tlf', nameOf)).toBe('Linie · 42 m')
    expect(connectedLineLabel({ coords, startAttachment: to('tlf'), endAttachment: to('live-1') }, 'tlf', nameOf)).toBe('Linie · 42 m')
  })

  it('keeps a numbered or named line as it is', () => {
    expect(connectedLineLabel({ coords, lineNo: 1, startAttachment: to('tlf') }, 'tlf', nameOf)).toBe('Leitung 1')
    expect(connectedLineLabel({ coords, label: 'Speiseleitung', startAttachment: to('tlf') }, 'tlf', nameOf)).toBe('Speiseleitung')
  })
})
