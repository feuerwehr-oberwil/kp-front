// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Sheet, SheetClose } from './Sheet'

afterEach(cleanup)

// appConfig.copy.closeDialog === 'Schliessen' (de base catalogue)
const CLOSE = 'Schliessen'

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(<Sheet open={false} onClose={vi.fn()} title="Titel">Inhalt</Sheet>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Inhalt')).toBeNull()
  })

  it('renders a labelled modal dialog with title, body and close button when open', () => {
    render(<Sheet open onClose={vi.fn()} title="Datenquelle">Körper</Sheet>)
    // Base UI enforces modality by marking sibling content inert (not aria-modal), so we just
    // assert the dialog role resolves and is named by its title.
    expect(screen.getByRole('dialog')).toBeTruthy()
    // the visible <h2> title also names the dialog (aria-labelledby wired by Base UI)
    expect(screen.getByRole('heading', { name: 'Datenquelle' })).toBeTruthy()
    expect(screen.getByText('Körper')).toBeTruthy()
    expect(screen.getByRole('button', { name: CLOSE })).toBeTruthy()
  })

  it('calls onClose when the header close button is clicked', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="T">x</Sheet>)
    fireEvent.click(screen.getByRole('button', { name: CLOSE }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="T">x</Sheet>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses ariaLabel when no visible title is given', () => {
    render(<Sheet open onClose={vi.fn()} ariaLabel="Stiller Dialog">x</Sheet>)
    expect(screen.getByRole('dialog', { name: 'Stiller Dialog' })).toBeTruthy()
  })

  it('SheetClose renders a dismissing button that closes the sheet', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="T" footer={<SheetClose>Fertig</SheetClose>}>x</Sheet>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
