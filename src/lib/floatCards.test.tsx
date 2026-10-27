// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useOnlyOpenCard } from './floatCards'

afterEach(cleanup)

function Card({ name, onClose }: { name: string; onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  useOnlyOpenCard(open, () => { setOpen(false); onClose?.() })
  return <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>{name}</button>
}
const card = (name: string) => screen.getByRole('button', { name })

// owner, staging 27.10.2026: the Gebäude card and the Messungen list stood open together
describe('useOnlyOpenCard — one card of the chip row at a time', () => {
  it('closes the open card when another one opens', () => {
    render(<><Card name="Gebäude" /><Card name="Messungen" /></>)
    fireEvent.click(card('Gebäude'))
    fireEvent.click(card('Messungen'))
    expect(card('Gebäude').getAttribute('aria-expanded')).toBe('false')
    expect(card('Messungen').getAttribute('aria-expanded')).toBe('true')
  })

  it('never «closes» a card that was not open (its close may mark it read)', () => {
    const closed = vi.fn()
    render(<><Card name="Gebäude" onClose={closed} /><Card name="Messungen" /></>)
    fireEvent.click(card('Messungen'))
    expect(closed).not.toHaveBeenCalled()
  })
})
