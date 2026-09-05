// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Overlays, toast, updateToast, dismissToast, confirmDialog } from './ui'

afterEach(() => {
  // toasts leave in two phases now (mark `.out`, remove .16s later) and the store is
  // module-level — flush pending exits so no fading pill leaks into the next test
  if (vi.isFakeTimers()) act(() => { vi.runAllTimers() })
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
  it('renders the action button; tapping it runs the handler and dismisses the toast', async () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => toast('Geschoss entfernt', { action: { label: 'Rückgängig', onClick } }))

    expect(screen.getByText('Geschoss entfernt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    // gone once the exit fade has played (dismissal is two-phase now)
    await waitFor(() => expect(screen.queryByText('Geschoss entfernt')).toBeNull())
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
  it('announces through one shared live region instead of nesting status regions', async () => {
    render(<Overlays />)
    let id!: number
    act(() => { id = toast('Einmal ansagen') })

    const host = document.querySelector('.toaster')!
    const item = screen.getByText('Einmal ansagen').closest('.toast')!
    expect(host.getAttribute('aria-live')).toBe('polite')
    expect(item.getAttribute('role')).toBeNull()
    act(() => dismissToast(id))
    await waitFor(() => expect(screen.queryByText('Einmal ansagen')).toBeNull())
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
    act(() => vi.advanceTimersByTime(4001)) // terminal state auto-dismisses…
    act(() => vi.advanceTimersByTime(200)) // …and the exit fade carries it out
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

  it('dismissToast removes a sticky toast and updateToast on an unknown id is a no-op', async () => {
    render(<Overlays />)
    let id!: number
    act(() => { id = toast('sticky', { sticky: true }) })
    act(() => dismissToast(id))
    // a leaving toast must also swallow updates — nothing may revive a pill mid-exit
    act(() => updateToast(id, 'ghost'))
    expect(screen.queryByText('ghost')).toBeNull()
    await waitFor(() => expect(screen.queryByText('sticky')).toBeNull())
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

  it('closes on the ✕ without undoing anything', async () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('mit ✕ weg', { action: { label: 'Rückgängig', onClick } }) })
    fireEvent.click(last('.toast-x'))
    await waitFor(() => expect(screen.queryByText('mit ✕ weg')).toBeNull())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('flicks away without undoing anything — a flick ends on the button, but is not a press', async () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('weggewischt', { action: { label: 'Rückgängig', onClick } }) })
    drag(last('.toast-action'), 90)
    await waitFor(() => expect(screen.queryByText('weggewischt')).toBeNull())
    expect(onClick).not.toHaveBeenCalled()
  })

  // …and a shaky press is still a press: the button is a target first and a slider second
  it('still undoes when the finger barely moved', async () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('zittrig gedrückt', { action: { label: 'Rückgängig', onClick } }) })
    drag(last('.toast-action'), 6)
    expect(onClick).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('zittrig gedrückt')).toBeNull())
  })
})

// The flick used to live only on the action cluster (Rückgängig/✕); the whole pill follows a
// horizontal drag now, so a message with no action cluster at all can be swiped away too.
// ⚠️ Look each pill up by its OWN text via `closest('.toast')`, never "the last `.toast` in the
// DOM" — the store is module-level and a previous test's still-visible pill can outlive its test,
// and the stack renders NEWEST-first (see Overlays), so a position-based lookup would as often as
// not grab someone else's toast.
describe('swiping the whole toast pill', () => {
  const pillFor = (text: string) => screen.getByText(text).closest('.toast') as HTMLElement
  const swipe = (el: Element, dx: number) => {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: dx })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: dx })
  }

  it('dismisses a plain toast on a drag past the flick threshold — no click needed', async () => {
    render(<Overlays />)
    act(() => { toast('weggewischte Nachricht') })
    swipe(pillFor('weggewischte Nachricht'), 90)
    await waitFor(() => expect(screen.queryByText('weggewischte Nachricht')).toBeNull())
  })

  it('springs back below the threshold — the pill stays, and a tap still dismisses it', async () => {
    render(<Overlays />)
    act(() => { toast('kaum bewegt') })
    swipe(pillFor('kaum bewegt'), 10)
    expect(screen.getByText('kaum bewegt')).toBeTruthy()
    fireEvent.click(pillFor('kaum bewegt'))
    await waitFor(() => expect(screen.queryByText('kaum bewegt')).toBeNull())
  })

  it('dragging the message area of an action toast dismisses it without running the undo', async () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => { toast('Aktion weggewischt', { action: { label: 'Rückgängig', onClick } }) })
    swipe(screen.getByText('Aktion weggewischt'), 90)
    await waitFor(() => expect(screen.queryByText('Aktion weggewischt')).toBeNull())
    expect(onClick).not.toHaveBeenCalled()
  })

  // ToastAction keeps its OWN drag (see ui.tsx) — starting a press on Rückgängig/✕ must never
  // also arm the whole-pill drag underneath it, or the two would fight over one touch.
  it('does not arm the whole-pill drag when the drag starts on the action cluster', () => {
    render(<Overlays />)
    act(() => { toast('nur Cluster', { action: { label: 'Rückgängig', onClick: vi.fn() } }) })
    const pill = pillFor('nur Cluster')
    swipe(screen.getByRole('button', { name: 'Rückgängig' }), 30) // below the button's own 56px flick
    expect(pill.style.transform).toBe('')
  })

  // No JS-side prefers-reduced-motion branch here on purpose (see ToastRow's comment): the travel
  // is a plain CSS transition, so it is already zeroed by the app-wide reduced-motion rule
  // (03-map.css) the same way every other CSS-only motion in the app is — nothing to unit-test.
})
