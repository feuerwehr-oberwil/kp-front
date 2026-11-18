// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installPressRelease, PRESS_LEFT_ATTR } from './pressRelease'

describe('pressRelease · the press wash goes where the finger has left', () => {
  let uninstall = () => {}
  afterEach(() => { uninstall(); document.body.innerHTML = '' })

  /** a row at 0…300 × 100…150, as the Einsatz menu's «Einsatz eröffnen» */
  function setup() {
    document.body.innerHTML = '<div id="menu"><button id="row"><span id="label">Einsatz eröffnen</span></button><p id="text">Text</p></div>'
    const row = document.getElementById('row')!
    row.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 150 } as DOMRect)
    uninstall = installPressRelease()
    return { row, label: document.getElementById('label')!, text: document.getElementById('text')! }
  }
  const left = () => document.documentElement.hasAttribute(PRESS_LEFT_ATTR)
  const at = (x: number, y: number) => [{ clientX: x, clientY: y }]

  it('keeps the press while the finger is on the control, drops it when it leaves, back on lift', () => {
    const { label } = setup()
    fireEvent.touchStart(label, { touches: at(20, 120) })
    fireEvent.touchMove(label, { touches: at(60, 140) })
    expect(left()).toBe(false)
    fireEvent.touchMove(label, { touches: at(60, 190) }) // on to the next row
    expect(left()).toBe(true)
    fireEvent.touchMove(label, { touches: at(60, 130) }) // a press once left stays left
    expect(left()).toBe(true)
    fireEvent.touchEnd(label, { touches: [], changedTouches: at(60, 130) })
    expect(left()).toBe(false)
  })

  it('a scroll under the finger drops it too', () => {
    const { row } = setup()
    fireEvent.touchStart(row, { touches: at(20, 120) })
    fireEvent.scroll(document.getElementById('menu')!)
    expect(left()).toBe(true)
  })

  it('a touch that did not start on a control marks nothing', () => {
    const { text } = setup()
    fireEvent.touchStart(text, { touches: at(20, 300) })
    fireEvent.touchMove(text, { touches: at(20, 500) })
    fireEvent.scroll(document.getElementById('menu')!)
    expect(left()).toBe(false)
  })
})
