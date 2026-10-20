// @vitest-environment jsdom
// The Massstab prompt: chips for the common lengths, the shared Stepper for any other – no native
// number field (UX sweep M3, 20.10.2026), and a typed decimal survives to the calibration.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanScalePrompt } from './PlanScalePrompts'

afterEach(cleanup)

function Harness({ onCommit }: { onCommit: (m: number) => void }) {
  const [refM, setRefM] = useState('10')
  return <PlanScalePrompt refMInput={refM} setRefMInput={setRefM} onCommit={onCommit} onClose={() => {}} />
}

describe('PlanScalePrompt', () => {
  it('has no native number field, and commits a typed decimal length', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    expect(document.querySelector('input[type=number]')).toBeNull()
    fireEvent.click(screen.getByText('10 m'))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '12,5' } })
    fireEvent.blur(input)
    expect(screen.getByText('12.5 m')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
    expect(onCommit).toHaveBeenCalledWith(12.5)
  })

  it('a chip picks the length, and ± steps from it', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button', { name: '50 m' }))
    fireEvent.pointerDown(screen.getByLabelText('mehr'))
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
    expect(onCommit).toHaveBeenCalledWith(51)
  })
})
