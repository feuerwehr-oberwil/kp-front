// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CtxShell } from './SheetGrip'

afterEach(cleanup)

const VH = window.visualViewport?.height ?? window.innerHeight

/** jsdom has no PointerEvent: build the touch by hand (same helper as overlays/swipeDismiss.test) */
function touch(el: Element, type: string, clientY: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY })
  Object.defineProperty(ev, 'pointerType', { value: 'touch' })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  fireEvent(el, ev)
}
const pull = (from: Element, dy: number) => { touch(from, 'pointerdown', 400); touch(from, 'pointermove', 400 + dy); touch(from, 'pointerup', 400 + dy) }

/** the phone's `.ctx`: hung on the bottom edge, its body a scroller with more than fits */
function sheet() {
  const onClose = vi.fn()
  const { container } = render(
    <CtxShell onClose={onClose}>
      <div className="ctx-head"><h3>Linie</h3></div>
      <div className="ctx-body"><p>Abschluss</p></div>
    </CtxShell>,
  )
  const root = container.querySelector('.ctx') as HTMLElement
  root.getBoundingClientRect = () => ({ top: 400, bottom: VH, left: 0, right: 390, width: 390, height: VH - 400, x: 0, y: 400, toJSON: () => ({}) }) as DOMRect
  const body = container.querySelector('.ctx-body') as HTMLElement
  body.style.overflowY = 'auto'
  Object.defineProperty(body, 'scrollHeight', { value: 900 })
  Object.defineProperty(body, 'clientHeight', { value: 300 })
  return { onClose, root, body, head: container.querySelector('.ctx-head')!, text: body.querySelector('p')! }
}

// Owner, sweep 27.10.2026 #13b: a detail sheet closes on a pull down anywhere in it, like Sheet.
describe('CtxShell · pull down to close', () => {
  it('closes on a pull from the body while it is scrolled to the top', () => {
    const { onClose, text } = sheet()
    pull(text, 140)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves a scrolled body its scroll', () => {
    const { onClose, body, text } = sheet()
    body.scrollTop = 80
    pull(text, 140)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves the header to its own half ⇄ full drag', () => {
    const { onClose, head } = sheet()
    pull(head, 140)
    expect(onClose).not.toHaveBeenCalled()
  })
})
