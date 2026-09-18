// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Sheet, SheetClose } from './Sheet'
import { usePopoverGuard, resetPopoverGuard } from './popoverGuard'

afterEach(() => { cleanup(); resetPopoverGuard() })

/** Stands in for any dropdown that opens over a sheet — a Combo's portalled menu, a Menu. */
function FakeDropdown({ open }: { open: boolean }) {
  usePopoverGuard(open)
  return null
}

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

  // ── a dropdown open inside the sheet owns the dismissing gesture ──
  // The reported bug: opening the Material combo in «Material erfassen» and then tapping away
  // closed the whole sheet, taking the half-filled form with it. Whatever is transient closes
  // first, and alone; the SECOND gesture reaches the sheet.
  describe('with a dropdown open inside it', () => {
    it('leaves the sheet standing on Escape, and closes it on the next one', () => {
      const onClose = vi.fn()
      const { rerender } = render(
        <Sheet open onClose={onClose} title="Material erfassen"><FakeDropdown open /></Sheet>,
      )
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      // …the dropdown has now closed itself; its own grace window has to lapse too
      rerender(<Sheet open onClose={onClose} title="Material erfassen"><FakeDropdown open={false} /></Sheet>)
      resetPopoverGuard()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('leaves the sheet standing on a press outside it', () => {
      const onClose = vi.fn()
      render(<Sheet open onClose={onClose} title="Material erfassen"><FakeDropdown open /></Sheet>)
      fireEvent.mouseDown(document.body)
      fireEvent.click(document.body)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('still closes on its own ✕ — the guard is about stray gestures, not about the button', () => {
      const onClose = vi.fn()
      render(<Sheet open onClose={onClose} title="Material erfassen"><FakeDropdown open /></Sheet>)
      fireEvent.click(screen.getByRole('button', { name: CLOSE }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
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
