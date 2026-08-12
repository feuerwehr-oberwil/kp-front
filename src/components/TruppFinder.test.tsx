// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TruppFinder } from './TruppFinder'
import type { PlacedTrupp } from '../lib/placedTrupps'

afterEach(cleanup)

const TRUPPS: PlacedTrupp[] = [
  { key: 'e1', name: 'Trupp 1', where: 'Lage', members: ['Müller Hans', 'Schmid Peter'], target: { kind: 'map', entityId: 'e1', coord: [7.57, 47.52] } },
  { key: 'a1', name: 'Trupp 2', where: 'Gebäude · 2. OG', members: ['Weber Marco'], status: 'raus', target: { kind: 'plan', planId: 'gebaeude', annoId: 'a1', x: 0.5, y: 0.5, floor: 2 } },
]

function open(trupps = TRUPPS) {
  const onPick = vi.fn(); const onClose = vi.fn()
  render(<TruppFinder trupps={trupps} onPick={onPick} onClose={onClose} />)
  return { onPick, onClose, input: screen.getByLabelText('Trupp finden', { selector: 'input' }) }
}

describe('TruppFinder', () => {
  it('lists every placed Trupp with where it stands', () => {
    open()
    expect(screen.getByText('Trupp 1')).toBeTruthy()
    expect(screen.getByText(/Gebäude · 2\. OG/)).toBeTruthy()
  })

  // the reason the finder searches members at all: you know who went in, not the number
  it('narrows by a member name', () => {
    const { input } = open()
    fireEvent.change(input, { target: { value: 'weber' } })
    expect(screen.queryByText('Trupp 1')).toBeNull()
    expect(screen.getByText('Trupp 2')).toBeTruthy()
  })

  it('picks the first hit on Enter and closes', () => {
    const { onPick, onClose, input } = open()
    fireEvent.change(input, { target: { value: 'weber' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: 'a1' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('walks the list with the arrow keys', () => {
    const { onPick, input } = open()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: 'a1' }))
  })

  it('says «kein Trupp gefunden» rather than showing an empty card', () => {
    const { input } = open()
    fireEvent.change(input, { target: { value: 'zzzz' } })
    expect(screen.getByText('Kein Trupp gefunden')).toBeTruthy()
  })

  // an empty list would read as a broken search — it has to say that nothing is placed YET
  it('explains where a Trupp comes from when none is placed', () => {
    open([])
    expect(screen.getByText('Noch kein Trupp platziert.')).toBeTruthy()
  })
})
