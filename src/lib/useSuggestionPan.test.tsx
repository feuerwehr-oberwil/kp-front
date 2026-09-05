// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSuggestionPan } from './useSuggestionPan'

afterEach(cleanup)

function Strip({ pick }: { pick: () => void }) {
  return <div role="group" {...useSuggestionPan()}><button onClick={pick}>Polizei</button></div>
}

function setup() {
  const pick = vi.fn()
  render(<Strip pick={pick} />)
  const row = screen.getByRole('group')
  const chip = screen.getByRole('button')
  Object.defineProperties(row, { clientWidth: { value: 300 }, scrollWidth: { value: 800 } })
  const pointer = (x: number, y = 100, pointerType = 'touch') => ({
    pointerId: 1, pointerType, clientX: x, clientY: y, button: 0,
  })
  return { row, chip, pick, pointer }
}

describe('suggestion strip touch drag', () => {
  it('leaves a still tap and its pointer defaults intact', () => {
    const { chip, pick, pointer } = setup()
    expect(fireEvent.pointerDown(chip, pointer(200))).toBe(true)
    expect(fireEvent.pointerMove(chip, pointer(202))).toBe(true)
    expect(fireEvent.pointerUp(chip, pointer(202))).toBe(true)
    fireEvent.click(chip, { detail: 1 })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('moves the actual scroll offset and suppresses the release click', () => {
    const { row, chip, pick, pointer } = setup()
    row.scrollLeft = 40
    fireEvent.pointerDown(chip, pointer(200))
    expect(fireEvent.pointerMove(chip, pointer(100, 104))).toBe(true)
    expect(row.scrollLeft).toBe(140)
    fireEvent.pointerUp(chip, pointer(100, 104))
    fireEvent.click(chip, { detail: 1 })
    expect(pick).not.toHaveBeenCalled()
  })

  it('clamps at both ends without changing the gesture origin', () => {
    const { row, chip, pointer } = setup()
    row.scrollLeft = 40
    fireEvent.pointerDown(chip, pointer(200))
    fireEvent.pointerMove(chip, pointer(300))
    expect(row.scrollLeft).toBe(0)
    fireEvent.pointerMove(chip, pointer(-400))
    expect(row.scrollLeft).toBe(500)
    fireEvent.pointerMove(chip, pointer(100))
    expect(row.scrollLeft).toBe(140)
  })

  it('leaves a vertical gesture to the browser and accepts the next tap after cancellation', () => {
    const { row, chip, pick, pointer } = setup()
    fireEvent.pointerDown(chip, pointer(200))
    expect(fireEvent.pointerMove(chip, pointer(196, 40))).toBe(true)
    expect(row.scrollLeft).toBe(0)
    fireEvent.pointerCancel(chip, pointer(196, 40))
    fireEvent.click(chip, { detail: 1 })
    expect(pick).not.toHaveBeenCalled()
    fireEvent.pointerDown(chip, pointer(200))
    fireEvent.pointerUp(chip, pointer(200))
    fireEvent.click(chip, { detail: 1 })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('never turns mouse movement or wheel input into touch dragging', () => {
    const { row, chip, pointer } = setup()
    fireEvent.pointerDown(chip, pointer(200, 100, 'mouse'))
    fireEvent.pointerMove(chip, pointer(100, 100, 'mouse'))
    fireEvent.pointerUp(chip, pointer(100, 100, 'mouse'))
    expect(row.scrollLeft).toBe(0)
    expect(fireEvent.wheel(row, { deltaX: 200 })).toBe(true)
  })

  it('accepts keyboard activation after a swipe', () => {
    const { chip, pick, pointer } = setup()
    fireEvent.pointerDown(chip, pointer(200))
    fireEvent.pointerMove(chip, pointer(100))
    fireEvent.pointerUp(chip, pointer(100))
    fireEvent.click(chip, { detail: 0 })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('ignores a second pointer until the active pointer ends', () => {
    const { row, chip, pointer } = setup()
    fireEvent.pointerDown(chip, pointer(200))
    fireEvent.pointerDown(chip, { ...pointer(250), pointerId: 2 })
    fireEvent.pointerMove(chip, { ...pointer(100), pointerId: 2 })
    expect(row.scrollLeft).toBe(0)
    fireEvent.pointerMove(chip, pointer(100))
    expect(row.scrollLeft).toBe(100)
  })

  it('captures the pressed chip for pen input so an ordinary pen tap still selects it', () => {
    const { row, chip, pick, pointer } = setup()
    chip.setPointerCapture = vi.fn()
    row.setPointerCapture = vi.fn()
    fireEvent.pointerDown(chip, pointer(200, 100, 'pen'))
    expect(chip.setPointerCapture).toHaveBeenCalledWith(1)
    expect(row.setPointerCapture).not.toHaveBeenCalled()
    fireEvent.pointerUp(chip, pointer(200, 100, 'pen'))
    fireEvent.click(chip, { detail: 1 })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('clears a lost pen capture so the next touch can scroll', () => {
    const { row, chip, pick, pointer } = setup()
    chip.setPointerCapture = vi.fn()
    fireEvent.pointerDown(chip, pointer(200, 100, 'pen'))
    fireEvent.lostPointerCapture(chip, pointer(200, 100, 'pen'))
    fireEvent.click(chip, { detail: 1 })
    expect(pick).not.toHaveBeenCalled()
    fireEvent.pointerDown(chip, pointer(200))
    fireEvent.pointerMove(chip, pointer(100))
    expect(row.scrollLeft).toBe(100)
  })
})
