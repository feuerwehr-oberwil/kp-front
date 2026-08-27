// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Stepper } from './Stepper'

afterEach(cleanup)

// the ± buttons carry the shared copy (appConfig.copy.stepper)
const LESS = 'weniger'
const MORE = 'mehr'
// a hold-repeat step fires on pointer-down, not on click
const tap = (label: string) => fireEvent.pointerDown(screen.getByLabelText(label))

// a storey stepper: EG (0) sits in the MIDDLE of its range, Untergeschosse below it
const floorProps = { min: -9, max: 40, seed: 0, seedOnDec: true, ariaLabel: 'Geschoss' }

describe('Stepper — an empty field with a neutral seed (Geschoss)', () => {
  it('seeds the origin on the first tap of EITHER − or +', () => {
    const onChange = vi.fn()
    render(<Stepper {...floorProps} value={null} onChange={onChange} />)
    tap(LESS)
    expect(onChange).toHaveBeenCalledWith(0)
    onChange.mockClear()
    tap(MORE)
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('steps DOWN from the origin into the Untergeschosse', () => {
    const onChange = vi.fn()
    render(<Stepper {...floorProps} value={0} onChange={onChange} />)
    tap(LESS)
    expect(onChange).toHaveBeenCalledWith(-1)
  })

  it('stops at the lowest storey', () => {
    render(<Stepper {...floorProps} value={-9} onChange={vi.fn()} />)
    expect((screen.getByLabelText(LESS) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Stepper — an empty field without seedOnDec', () => {
  it('leaves − disabled (a count has nothing below its seed)', () => {
    const onChange = vi.fn()
    render(<Stepper value={null} min={0} max={999} seed={1} onChange={onChange} ariaLabel="Anzahl" />)
    expect((screen.getByLabelText(LESS) as HTMLButtonElement).disabled).toBe(true)
    tap(MORE)
    expect(onChange).toHaveBeenCalledWith(1)
  })
})

describe('Stepper — typing the value in', () => {
  const startTyping = () => {
    fireEvent.click(screen.getByTitle('Tippen zum Eingeben'))
    return screen.getByRole('textbox') as HTMLInputElement
  }

  it('takes a typed negative storey', () => {
    const onChange = vi.fn()
    render(<Stepper {...floorProps} value={null} onChange={onChange} />)
    const input = startTyping()
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(-1)
  })

  it('clamps a typed value into the range', () => {
    const onChange = vi.fn()
    render(<Stepper {...floorProps} value={null} onChange={onChange} />)
    const input = startTyping()
    fireEvent.change(input, { target: { value: '-99' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(-9)
  })

  it('keeps the draft numeric — digits and ONE leading minus', () => {
    render(<Stepper {...floorProps} value={null} onChange={vi.fn()} />)
    const input = startTyping()
    fireEvent.change(input, { target: { value: '-1-2a' } })
    expect(input.value).toBe('-12')
  })

  it('preselects the current value so typing replaces it', () => {
    render(<Stepper {...floorProps} value={3} onChange={vi.fn()} />)
    const input = startTyping()
    expect(input.value).toBe('3')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1])
  })

  it('leaves the value alone when nothing usable was typed', () => {
    const onChange = vi.fn()
    render(<Stepper {...floorProps} value={2} onChange={onChange} />)
    const input = startTyping()
    fireEvent.change(input, { target: { value: '-' } })   // mid-typing, no digits yet
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })
})
