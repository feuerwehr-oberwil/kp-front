// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Sheet } from './Sheet'

afterEach(cleanup)

// the sheet is measured against the REAL viewport the gesture will be judged against
const VH = window.visualViewport?.height ?? window.innerHeight

/** Lay the popup out the way a phone does: hung on the bottom edge, leaving screen above it. */
function asBottomSheet(el: HTMLElement, top = 300) {
  el.getBoundingClientRect = () => ({
    top, bottom: VH, left: 0, right: 390, width: 390, height: VH - top, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

function open(onClose = vi.fn()) {
  render(<Sheet open onClose={onClose} title="Material erfassen"><p>Inhalt</p></Sheet>)
  const popup = screen.getByRole('dialog')
  asBottomSheet(popup)
  return { popup, onClose, head: popup.querySelector('.ip-head') as HTMLElement }
}

/** jsdom implements no PointerEvent, so testing-library drops `pointerType`/`pointerId` off the
 *  init — and this gesture is touch-only by design. Build the event by hand instead. */
function touch(el: Element, type: string, clientY: number, clientX = 100) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })
  Object.defineProperty(ev, 'pointerType', { value: 'touch' })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  fireEvent(el, ev)
}

/** One finger, straight down, starting on `from` — the handlers sit on the popup and the event
 *  bubbles up to them, which is exactly how the real gesture arrives. */
function swipe(_popup: HTMLElement, from: HTMLElement, dy: number) {
  touch(from, 'pointerdown', 400)
  touch(from, 'pointermove', 400 + dy)
  touch(from, 'pointerup', 400 + dy)
}

describe('a phone bottom sheet closes by being pushed down', () => {
  it('draws the grab bar that says so', () => {
    const { popup } = open()
    expect(popup.querySelector('.ui-sheet-grab')).toBeTruthy()
  })

  it('closes on a pull from the header', () => {
    const { popup, head, onClose } = open()
    swipe(popup, head, 140)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never starts on a map — a downward PAN of a sheet\'s mini-map is the map\'s gesture', () => {
    // the PlanPicker is a bottom sheet with a MapLibre map in it (components/PlanPicker): before
    // this, panning that map southwards slid the sheet away under the finger
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Anderes Objekt">
        <div className="maplibregl-map"><div className="maplibregl-canvas-container"><canvas /></div></div>
      </Sheet>,
    )
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    swipe(popup, popup.querySelector('canvas') as unknown as HTMLElement, 140)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('…and a surface can say so itself with `data-swipe-ignore`', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Skizze"><div data-swipe-ignore=""><span>Fläche</span></div></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    swipe(popup, screen.getByText('Fläche'), 140)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('snaps back when the pull was not enough — a half gesture is not a decision', () => {
    const { popup, head, onClose } = open()
    swipe(popup, head, 30)
    expect(onClose).not.toHaveBeenCalled()
    expect(popup.style.transform).toBe('')
  })

  it('ignores an UPWARD drag: that gesture belongs to the content', () => {
    const { popup, head, onClose } = open()
    swipe(popup, head, -140)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never starts on a control — the ✕ still closes on the first tap', () => {
    const { popup, onClose } = open()
    const x = screen.getByRole('button', { name: 'Schliessen' })
    swipe(popup, x, 140)
    // the drag never armed, so nothing was dismissed by the gesture itself
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not exist on a centred dialog — there is no «down» to push it to', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="T"><p>x</p></Sheet>)
    const popup = screen.getByRole('dialog')
    popup.getBoundingClientRect = () => ({
      top: 100, bottom: VH - 100, left: 0, right: 700, width: 700, height: VH - 200, x: 0, y: 100,
      toJSON: () => ({}),
    }) as DOMRect
    swipe(popup, popup.querySelector('.ip-head') as HTMLElement, 200)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves a body that has been scrolled to its own scroller', () => {
    const { popup, onClose } = open()
    const body = popup.querySelector('.ip-body') as HTMLElement
    Object.defineProperties(body, {
      scrollTop: { value: 120, writable: true },
      scrollHeight: { value: 900 },
      clientHeight: { value: 400 },
    })
    // jsdom reports no computed overflow for the class, so say what the stylesheet says
    body.style.overflowY = 'auto'
    swipe(popup, body, 160)
    expect(onClose).not.toHaveBeenCalled()
  })
})
