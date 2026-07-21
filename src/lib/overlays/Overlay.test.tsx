// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Overlay } from './Overlay'

afterEach(cleanup)

describe('Overlay', () => {
  it('renders its children inside a labelled dialog when open', () => {
    render(<Overlay open onClose={vi.fn()} className="ip-sheet ui-dialog" ariaLabel="Test">Körper</Overlay>)
    expect(screen.getByRole('dialog', { name: 'Test' })).toBeTruthy()
    expect(screen.getByText('Körper')).toBeTruthy()
  })

  it('renders nothing when closed', () => {
    render(<Overlay open={false} onClose={vi.fn()} className="ip-sheet ui-dialog" ariaLabel="Test">x</Overlay>)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape by default', () => {
    const onClose = vi.fn()
    render(<Overlay open onClose={onClose} className="ip-sheet ui-dialog" ariaLabel="Test">x</Overlay>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close on Escape when dismissEscape={false} (the surface owns Esc)', () => {
    const onClose = vi.fn()
    render(<Overlay open onClose={onClose} className="ip-sheet ui-dialog" ariaLabel="Test" dismissEscape={false}>x</Overlay>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
