// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Popover, PopoverClose } from './Popover'

afterEach(cleanup)

describe('Popover', () => {
  it('is closed until the trigger is clicked, then shows content', () => {
    render(<Popover trigger={<button>Wetter</button>}>Details hier</Popover>)
    expect(screen.queryByText('Details hier')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Wetter' }))
    expect(screen.getByText('Details hier')).toBeTruthy()
  })

  it('sets aria-expanded on the trigger when open', () => {
    render(<Popover trigger={<button>Wetter</button>}>x</Popover>)
    const trigger = screen.getByRole('button', { name: 'Wetter' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on Escape', () => {
    render(<Popover trigger={<button>Wetter</button>} ariaLabel="Wetter-Details">Inhalt</Popover>)
    fireEvent.click(screen.getByRole('button', { name: 'Wetter' }))
    const pop = screen.getByText('Inhalt')
    fireEvent.keyDown(pop, { key: 'Escape' })
    expect(screen.queryByText('Inhalt')).toBeNull()
  })

  it('PopoverClose dismisses and runs its onClick', () => {
    const onClick = vi.fn()
    render(
      <Popover trigger={<button>Wetter</button>}>
        <PopoverClose onClick={onClick}>Radar öffnen</PopoverClose>
      </Popover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Wetter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Radar öffnen' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Radar öffnen')).toBeNull()
  })
})
