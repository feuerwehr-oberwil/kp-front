// @vitest-environment jsdom
//
// «Kopieren nach …» as the stack (owner pick A, round 3): every storey a row in building order,
// the source shown but not pickable, the button naming the result.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnno } from '../types'
import { StoreyCopySheet } from './StoreyCopySheet'

afterEach(cleanup)

const wand = (id: string): BoardAnno => ({ id, kind: 'draw', role: 'wand', pts: [[0, 0], [1, 0]] })
const sym = (id: string, symbol: string): BoardAnno => ({ id, kind: 'symbol', symbol, x: 0.5, y: 0.5 })
const og2 = [wand('w1'), wand('w2'), wand('w3'), ...[1, 2, 3, 4].map((i) => sym(`d${i}`, 'GB Ture Durchgang')), sym('t', 'GB Treppe 8')]
const storeys = [
  { floor: 3, name: '3. OG', items: [] },
  { floor: 2, name: '2. OG', items: og2 },
  { floor: 1, name: '1. OG', items: [] },
  { floor: 0, name: 'EG', items: [wand('e1'), wand('e2')] },
]
const open = (onCopy = vi.fn(), from = 2, list = storeys) => {
  render(<StoreyCopySheet from={from} storeys={list} onCopy={onCopy} onClose={() => {}} />)
  return onCopy
}
const button = () => screen.getByRole('button', { name: /kopieren|wählen/ })

describe('StoreyCopySheet', () => {
  it('says what goes by kind, and lists every storey top to bottom with the Vorlage not pickable', () => {
    open()
    expect(screen.getByText('3 Wände · 4× Durchgang · 1× Treppe')).toBeTruthy()
    expect(screen.getAllByRole('checkbox').map((c) => c.textContent)).toEqual(['3. OGleer', '1. OGleer', 'EG2 Wände – kommt dazu'])
    const rows = [...document.querySelectorAll('.wb-copy-row')].map((r) => r.querySelector('.wb-copy-name')!.textContent)
    expect(rows).toEqual(['3. OG', '2. OG', '1. OG', 'EG'])
    expect(document.querySelector('.wb-copy-src')!.textContent).toContain('Vorlage')
  })

  it('names the result in the button: none, one storey, several', () => {
    const onCopy = open()
    expect(button().textContent).toBe('Geschoss wählen')
    expect((button() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /1\. OG/ }))
    expect(button().textContent).toBe('Auf 1. OG kopieren')
    fireEvent.click(screen.getByRole('checkbox', { name: /EG/ }))
    expect(button().textContent).toBe('Auf 2 Geschosse kopieren')
    fireEvent.click(button())
    expect(onCopy).toHaveBeenCalledWith([1, 0])
  })

  it('«Alle» picks every other storey, then reads «Keine»', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }))
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true')).toBe(true)
    expect(button().textContent).toBe('Auf 3 Geschosse kopieren')
    fireEvent.click(screen.getByRole('button', { name: 'Keine' }))
    expect(screen.getAllByRole('checkbox').some((c) => c.getAttribute('aria-checked') === 'true')).toBe(false)
  })

  it('a storey with nothing to copy says so and offers no rows', () => {
    open(vi.fn(), 1)
    expect(screen.getByText(/keinen Grundriss/)).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })
})
