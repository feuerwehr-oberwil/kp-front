// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Overlays, toast, updateToast, dismissToast, confirmDialog } from './ui'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('confirmDialog (Base UI AlertDialog)', () => {
  it('shows the message and resolves true when the confirm action is clicked', async () => {
    render(<Overlays />)
    let p!: Promise<boolean>
    act(() => { p = confirmDialog({ title: 'Löschen?', message: 'Wirklich löschen?', confirmLabel: 'Löschen', cancelLabel: 'Abbrechen', danger: true }) })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText('Wirklich löschen?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    await expect(p).resolves.toBe(true)
  })

  it('resolves false when cancelled', async () => {
    render(<Overlays />)
    let p!: Promise<boolean>
    act(() => { p = confirmDialog({ message: 'X?', confirmLabel: 'Ja', cancelLabel: 'Nein' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Nein' }))
    await expect(p).resolves.toBe(false)
  })

  it('resolves false on Escape', async () => {
    render(<Overlays />)
    let p!: Promise<boolean>
    act(() => { p = confirmDialog({ message: 'X?', confirmLabel: 'Ja', cancelLabel: 'Nein' }) })
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await expect(p).resolves.toBe(false)
  })
})

describe('toast with an action (confirm-with-undo)', () => {
  it('renders the action button; tapping it runs the handler and dismisses the toast', () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => toast('Geschoss entfernt', { action: { label: 'Rückgängig', onClick } }))

    expect(screen.getByText('Geschoss entfernt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Geschoss entfernt')).toBeNull()
  })

  it('gives an actioned toast a longer default lifetime than a plain one', () => {
    vi.useFakeTimers()
    render(<Overlays />)
    act(() => {
      toast('plain')
      toast('mit Undo', { action: { label: 'Rückgängig', onClick: vi.fn() } })
    })

    act(() => vi.advanceTimersByTime(3000)) // past the plain 2.8s default
    expect(screen.queryByText('plain')).toBeNull()
    expect(screen.getByText('mit Undo')).toBeTruthy()

    act(() => vi.advanceTimersByTime(3500)) // past the 6s action default
    expect(screen.queryByText('mit Undo')).toBeNull()
  })
})

describe('sticky/updatable toast (live print status)', () => {
  it('a sticky toast stays put, then updateToast patches it in place', () => {
    vi.useFakeTimers()
    render(<Overlays />)
    let id!: number
    act(() => { id = toast('An Stationsdrucker gesendet', { sticky: true, icon: 'check' }) })

    act(() => vi.advanceTimersByTime(10_000)) // no auto-dismiss while sticky
    expect(screen.getByText('An Stationsdrucker gesendet')).toBeTruthy()

    act(() => updateToast(id, 'Wird gedruckt …', { icon: 'print' }))
    expect(screen.queryByText('An Stationsdrucker gesendet')).toBeNull()
    expect(screen.getByText('Wird gedruckt …')).toBeTruthy()

    act(() => updateToast(id, 'Gedruckt', { icon: 'check', duration: 4000 }))
    expect(screen.getByText('Gedruckt')).toBeTruthy()
    act(() => vi.advanceTimersByTime(4001)) // terminal state auto-dismisses
    expect(screen.queryByText('Gedruckt')).toBeNull()
  })

  it('dismissToast removes a sticky toast and updateToast on an unknown id is a no-op', () => {
    render(<Overlays />)
    let id!: number
    act(() => { id = toast('sticky', { sticky: true }) })
    act(() => dismissToast(id))
    expect(screen.queryByText('sticky')).toBeNull()
    act(() => updateToast(id, 'ghost'))
    expect(screen.queryByText('ghost')).toBeNull()
  })
})
