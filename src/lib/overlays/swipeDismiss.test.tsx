// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { Sheet } from './Sheet'
import { isDismissPull, releaseVelocity, rubberBand, useSwipeDismiss } from './swipeDismiss'

// the exit slides out before `onClose` (swipeDismiss · slideOut): the clock is ours to run
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Let the exit slide run out — `onClose` comes at its end. */
const slidOut = () => act(() => { vi.advanceTimersByTime(400) })

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
  // the release speed is read off the moves' time stamps: the fake clock, so a test says how fast
  Object.defineProperty(ev, 'timeStamp', { value: Date.now() })
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
    slidOut()
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

  // sweep 28.10.2026 #1 (owner: «Ebenen just continues scrolling the content instead of closing it»)
  it('a pull that starts on a ROW closes like any other point of the body, and its click is swallowed', () => {
    const onClose = vi.fn(), onRow = vi.fn()
    render(<Sheet open onClose={onClose} title="Ebenen"><button type="button" onClick={onRow}>Hydranten</button></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    const row = screen.getByRole('button', { name: 'Hydranten' })
    swipe(popup, row, 140)
    fireEvent.click(row) // the click the press ends in
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })

  it('…while a tap on a row (or the ✕) stays a tap', () => {
    const onClose = vi.fn(), onRow = vi.fn()
    render(<Sheet open onClose={onClose} title="Ebenen"><button type="button" onClick={onRow}>Hydranten</button></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    const row = screen.getByRole('button', { name: 'Hydranten' })
    swipe(popup, row, 4)
    fireEvent.click(row)
    expect(onRow).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never starts on a field or a slider — their drag is theirs', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Einstellungen"><input aria-label="Name" /><span role="slider" aria-valuenow={1} aria-label="Grösse" tabIndex={0} /></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    swipe(popup, screen.getByRole('textbox'), 140)
    swipe(popup, screen.getByRole('slider'), 140)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('claims a downward touch from the browser while it is a pull — never an upward one', () => {
    // iOS answers an unclaimed pull at the top with its rubber band and a pointercancel: the sheet
    // never moved. Pointer events arrive before their touch events, so the claim reads the drag.
    const { popup } = open()
    const body = popup.querySelector('.ip-body') as HTMLElement
    const touchmove = (y: number) => {
      const ev = new Event('touchmove', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'touches', { value: [{ clientX: 100, clientY: y }] })
      body.dispatchEvent(ev)
      return ev.defaultPrevented
    }
    touch(body, 'pointerdown', 400)
    touch(body, 'pointermove', 403)
    expect(touchmove(403)).toBe(true)
    touch(body, 'pointerup', 403)
    // released: nothing is claimed any more
    expect(touchmove(420)).toBe(false)
    // upwards is the content's — the pull is dropped and the touch left alone
    touch(body, 'pointerdown', 400)
    touch(body, 'pointermove', 380)
    expect(touchmove(380)).toBe(false)
    touch(body, 'pointerup', 380)
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
    scroller(body, 120)
    swipe(popup, body, 160)
    expect(onClose).not.toHaveBeenCalled()
  })
})

/** Make `el` a vertical scroller of the given state — jsdom lays nothing out and reports no
 *  computed overflow for a class, so say what the stylesheet and the scroll position say. */
function scroller(el: HTMLElement, scrollTop: number) {
  Object.defineProperties(el, {
    scrollTop: { value: scrollTop, writable: true },
    scrollHeight: { value: 900 },
    clientHeight: { value: 400 },
  })
  el.style.overflowY = 'auto'
}

// scroll sweep 15.11.2026 #1: only the innermost scroller was asked, and never the popup, so a
// list at its top inside a scrolled-down form closed the sheet instead of scrolling it back up
describe('every scroller between the finger and the popup must be at its top', () => {
  it('a list at its top inside a scrolled body scrolls the body, it does not close', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Einsatz eröffnen"><ul data-testid="list"><li>Objekt</li></ul></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    scroller(popup.querySelector('.ip-body') as HTMLElement, 300)
    scroller(screen.getByTestId('list'), 0)
    swipe(popup, screen.getByText('Objekt'), 160)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a popup that scrolls itself, scrolled down, keeps the gesture for its content', () => {
    const onClose = vi.fn()
    function Composer() {
      const swipe = useSwipeDismiss({ onClose })
      return <section data-testid="sheet" {...swipe}><p>Text</p></section>
    }
    render(<Composer />)
    const sheet = screen.getByTestId('sheet')
    asBottomSheet(sheet)
    scroller(sheet, 200)
    swipe(sheet, screen.getByText('Text'), 160)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('…and with all of them at their top the same pull closes', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Einsatz eröffnen"><ul data-testid="list"><li>Objekt</li></ul></Sheet>)
    const popup = screen.getByRole('dialog')
    asBottomSheet(popup)
    scroller(popup.querySelector('.ip-body') as HTMLElement, 0)
    scroller(screen.getByTestId('list'), 0)
    swipe(popup, screen.getByText('Objekt'), 160)
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// `headOnly` (the Karte's search and Gefahrgut sheets, owner review round 4: «ensure it only scrolls
// the listed objects»): a pull on the result list — even at its top, where an ordinary sheet's body
// hands the gesture to the sheet — never moves the sheet; the head still closes it.
describe('headOnly: only the head drags the sheet', () => {
  function KeySheet({ onClose }: { onClose: () => void }) {
    const swipe = useSwipeDismiss({ onClose, headOnly: true })
    return (
      <section data-testid="sheet" {...swipe}>
        <div data-sheet-head="">Feld</div>
        <div style={{ overflowY: 'auto' }}><p>Treffer</p></div>
      </section>
    )
  }
  it('a pull over the list is the list\'s, a pull on the head closes', () => {
    const onClose = vi.fn()
    render(<KeySheet onClose={onClose} />)
    const sheet = screen.getByTestId('sheet')
    asBottomSheet(sheet)
    swipe(sheet, screen.getByText('Treffer'), 140)
    expect(onClose).not.toHaveBeenCalled()
    expect(sheet.style.transform).toBe('')
    swipe(sheet, screen.getByText('Feld'), 140)
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// design pass 18.11.2026 (B1–B4): the pull lets go the way a phone sheet does
describe('letting go', () => {
  it('leaves DOWNWARDS from where the finger let go, and closes at the end of the slide', () => {
    const { popup, head, onClose } = open()
    touch(head, 'pointerdown', 400)
    touch(head, 'pointermove', 540)
    expect(popup.style.transform).toBe('translateY(130px)')
    touch(head, 'pointerup', 540)
    // from the finger's 130px on down — not back up to 0 first
    expect(popup.style.transform).toBe('translateY(100%)')
    expect(onClose).not.toHaveBeenCalled()
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('…and the next press during the slide closes at once: that tap lands on a closed screen', () => {
    const { head, onClose } = open()
    swipe(head, head, 140)
    act(() => { window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the ✕ of a phone bottom sheet slides it down too', () => {
    const { popup, onClose } = open()
    fireEvent.click(screen.getByRole('button', { name: /schliessen/i }))
    expect(popup.style.transform).toBe('translateY(100%)')
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a parent that does not close (it asks first) gets its sheet back', () => {
    const { popup, head } = open() // onClose is a spy: the sheet stays mounted
    swipe(head, head, 140)
    slidOut()
    expect(popup.style.transform).toBe('')
    expect(popup.style.pointerEvents).toBe('')
  })

  it('the scrim follows the pull and comes back with the snap', () => {
    const { popup, head } = open()
    Object.defineProperty(popup, 'offsetHeight', { value: 400 })
    const scrim = document.querySelector('.ui-backdrop') as HTMLElement
    touch(head, 'pointerdown', 400)
    touch(head, 'pointermove', 510) // 100px of pull on a 400px sheet
    expect(scrim.style.opacity).toBe('0.75')
    touch(head, 'pointermove', 450) // 40px, and let go slowly
    act(() => { vi.advanceTimersByTime(200) })
    touch(head, 'pointerup', 450)
    expect(scrim.style.opacity).toBe('')
    expect(popup.style.transform).toBe('')
  })

  it('a slow pull that ends in a flick closes — the speed is the release\'s, not the average', () => {
    const { head, onClose } = open()
    // a move every 16ms: 40px at a crawl (0.06px/ms), then 60px at 0.6px/ms — 90px of pull, under
    // the 96 that closes by distance, and 0.14px/ms averaged from the press
    let y = 400
    touch(head, 'pointerdown', y)
    const step = (px: number) => { act(() => { vi.advanceTimersByTime(16) }); y += px; touch(head, 'pointermove', y) }
    for (let i = 0; i < 40; i++) step(1)
    for (let i = 0; i < 6; i++) step(10)
    touch(head, 'pointerup', y)
    slidOut()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pulled up past where it stands, the sheet follows less than the finger', () => {
    const { popup, head } = open()
    Object.defineProperty(popup, 'offsetHeight', { value: 400 })
    touch(head, 'pointerdown', 400)
    touch(head, 'pointermove', 420) // engaged, 10px down
    touch(head, 'pointermove', 310) // 100px above the start
    const y = Number(/translateY\((-?[\d.]+)px\)/.exec(popup.style.transform)?.[1])
    expect(y).toBeLessThan(0)
    expect(y).toBeGreaterThan(-100)
    touch(head, 'pointerup', 310)
  })

  it('a press during the snap back takes the sheet where it stands', () => {
    const { popup, head } = open()
    // 30px down mid-flight: its rect is 30px lower than the bottom sheet it is landing as
    popup.style.transform = 'matrix(1, 0, 0, 1, 0, 30)'
    popup.getBoundingClientRect = () => ({
      top: 330, bottom: VH + 30, left: 0, right: 390, width: 390, height: VH - 300, x: 0, y: 330,
      toJSON: () => ({}),
    }) as DOMRect
    touch(head, 'pointerdown', 400)
    touch(head, 'pointermove', 410)
    expect(popup.style.transform).toBe('translateY(30px)')
    expect(popup.style.transition).toBe('none')
    touch(head, 'pointerup', 410)
  })
})

describe('the release rules', () => {
  it('far enough, or a flick after a shorter pull — never while pushing it back up', () => {
    expect(isDismissPull(120, 0)).toBe(true)
    expect(isDismissPull(60, 0.8)).toBe(true)
    expect(isDismissPull(60, 0.2)).toBe(false)
    expect(isDismissPull(20, 2)).toBe(false)
    expect(isDismissPull(150, -0.8)).toBe(false)
  })

  it('the speed is the last ~80ms, measured back to the window\'s edge', () => {
    const slowThenFast = [{ t: 0, y: 0 }, { t: 500, y: 40 }, { t: 900, y: 50 }, { t: 960, y: 98 }, { t: 980, y: 114 }]
    expect(releaseVelocity(slowThenFast)).toBeCloseTo(64 / 80)
    const fastThenStill = [{ t: 0, y: 0 }, { t: 40, y: 80 }, { t: 400, y: 82 }]
    expect(releaseVelocity(fastThenStill)).toBeCloseTo(2 / 360)
    expect(releaseVelocity([{ t: 5, y: 9 }])).toBe(0)
  })

  it('the rubber band gives less the further it is pulled', () => {
    expect(rubberBand(0, 400)).toBe(0)
    expect(rubberBand(100, 400)).toBeLessThan(100)
    expect(rubberBand(200, 400) - rubberBand(100, 400)).toBeLessThan(rubberBand(100, 400))
  })
})
