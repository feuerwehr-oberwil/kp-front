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

describe('toast timing', () => {
  it('announces through one shared live region instead of nesting status regions', () => {
    render(<Overlays />)
    let id!: number
    act(() => { id = toast('Einmal ansagen') })

    const host = document.querySelector('.toaster')!
    const item = screen.getByText('Einmal ansagen').closest('.toast')!
    expect(host.getAttribute('aria-live')).toBe('polite')
    expect(item.getAttribute('role')).toBeNull()
    act(() => dismissToast(id))
  })

  it('keeps a long message visible long enough to read', () => {
    vi.useFakeTimers()
    render(<Overlays />)
    const message = `Server: ${'Eine ausführliche Fehlermeldung. '.repeat(4)}`.trim()
    act(() => { toast(message) })

    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText(message)).toBeTruthy()
    act(() => vi.advanceTimersByTime(7001))
    expect(screen.queryByText(message)).toBeNull()
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

    act(() => updateToast(id, 'Wird gedruckt …', { icon: 'printer' }))
    expect(screen.queryByText('An Stationsdrucker gesendet')).toBeNull()
    expect(screen.getByText('Wird gedruckt …')).toBeTruthy()

    act(() => updateToast(id, 'Gedruckt', { icon: 'check', duration: 4000 }))
    expect(screen.getByText('Gedruckt')).toBeTruthy()
    act(() => vi.advanceTimersByTime(4001)) // terminal state auto-dismisses
    expect(screen.queryByText('Gedruckt')).toBeNull()
  })

  it('a step chain renders every stage and keeps the plain sentence for screen readers', () => {
    render(<Overlays />)
    let id!: number
    act(() => {
      id = toast('An Stationsdrucker gesendet', {
        sticky: true,
        steps: [
          { label: 'Gesendet', state: 'now', icon: 'check' },
          { label: 'Wird gedruckt', state: 'future' },
          { label: 'Gedruckt', state: 'future' },
        ],
      })
    })
    // the chain shows where the job is AND what is still to come...
    expect(screen.getByText('Gesendet')).toBeTruthy()
    expect(screen.getByText('Wird gedruckt')).toBeTruthy()
    expect(screen.getByText('Gedruckt')).toBeTruthy()
    // ...while the announcement stays a sentence — three stage names read aloud say nothing
    expect(screen.getByText('An Stationsdrucker gesendet')).toBeTruthy()

    act(() => updateToast(id, 'Wird gedruckt …', {
      steps: [
        { label: 'Gesendet', state: 'done', icon: 'check' },
        { label: 'Wird gedruckt', state: 'now', icon: 'printer' },
        { label: 'Gedruckt', state: 'future' },
      ],
    }))
    expect(document.querySelector('.toast-step.now .print-feed')).toBeTruthy()
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

// Action toasts can be dismissed immediately when their bounded stack is in the way.
describe('getting a confirm-with-undo toast out of the way', () => {
  /** the toast just raised — the store is module-level, so a previous test's pill may still stand */
  const last = (sel: string) => [...document.querySelectorAll(`.toast ${sel}`)].pop() as HTMLElement
  const drag = (el: Element, dx: number) => {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: dx })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: dx })
    fireEvent.click(el)
  }

  it('closes on the ✕ without undoing anything', () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('mit ✕ weg', { action: { label: 'Rückgängig', onClick } }) })
    fireEvent.click(last('.toast-x'))
    expect(screen.queryByText('mit ✕ weg')).toBeNull()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('flicks away without undoing anything — a flick ends on the button, but is not a press', () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('weggewischt', { action: { label: 'Rückgängig', onClick } }) })
    drag(last('.toast-action'), 90)
    expect(screen.queryByText('weggewischt')).toBeNull()
    expect(onClick).not.toHaveBeenCalled()
  })

  // …and a shaky press is still a press: the button is a target first and a slider second
  it('still undoes when the finger barely moved', () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('zittrig gedrückt', { action: { label: 'Rückgängig', onClick } }) })
    drag(last('.toast-action'), 6)
    expect(onClick).toHaveBeenCalled()
    expect(screen.queryByText('zittrig gedrückt')).toBeNull()
  })
})
