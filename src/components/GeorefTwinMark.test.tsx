// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TwinMark } from './GeorefTwinMark'

afterEach(cleanup)

const props = {
  svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
  sizePx: 48,
  rotation: 0,
  caption: 'Brandherd',
  title: 'Brandherd – gespiegelt',
}

describe('a Georeferenz twin mark', () => {
  it('opens its details on a tap', () => {
    const onOpen = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={onOpen} />)
    fireEvent.click(getByRole('button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is the source glyph itself, without a permanent swap badge', () => {
    const { getByRole } = render(<TwinMark {...props} onOpen={() => {}} />)
    expect(getByRole('button').textContent).not.toContain('⇄')
  })

  it('uses the ordinary selection halo while its shared details are open', () => {
    const { getByRole } = render(<TwinMark {...props} selected onOpen={() => {}} />)
    expect(getByRole('button').querySelector('.sel-halo')).toBeTruthy()
  })

  // no `onMove` ⇒ tap-only, which is what a locked surface and a viewer session get
  it('ignores a drag when the surface does not offer one', () => {
    const onOpen = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={onOpen} />)
    const mark = getByRole('button')
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(mark, { pointerId: 1, clientX: 30, clientY: 30 })
    fireEvent.pointerUp(mark, { pointerId: 1, clientX: 35, clientY: 35 })
    fireEvent.click(mark)
    expect(onOpen).toHaveBeenCalledTimes(1)  // it was a tap, because nothing else was on offer
  })
})

describe('a twin the surface lets you move', () => {
  const drag = (mark: Element, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: from[0], clientY: from[1] })
    fireEvent.pointerMove(mark, { pointerId: 1, clientX: to[0], clientY: to[1] })
    fireEvent.pointerUp(mark, { pointerId: 1, clientX: to[0], clientY: to[1] })
  }

  it('reports the travel as a delta, opening on the first sample past the slop', () => {
    const onMove = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={() => {}} onMove={onMove} />)
    drag(getByRole('button'), [100, 100], [140, 130])
    expect(onMove.mock.calls).toEqual([
      ['start', 0, 0],
      ['move', 40, 30],
      ['end', 40, 30],
    ])
  })

  // the whole point of the slop: a fingertip's wobble on a glove must not move the object
  it('stays a tap when the finger never travels', () => {
    const onOpen = vi.fn(); const onMove = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={onOpen} onMove={onMove} />)
    const mark = getByRole('button')
    drag(mark, [100, 100], [102, 101])
    fireEvent.click(mark)
    expect(onMove).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  // ⚠️ a drag must not ALSO open the details panel behind the object just moved
  it('does not open the details after a real drag', () => {
    const onOpen = vi.fn(); const onMove = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={onOpen} onMove={onMove} />)
    const mark = getByRole('button')
    drag(mark, [100, 100], [140, 130])
    fireEvent.click(mark)
    expect(onOpen).not.toHaveBeenCalled()
    // …and the next tap still opens it — the suppression is for that one click only
    fireEvent.click(mark)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is inert while a tool is armed, even though the surface offers movement', () => {
    const onMove = vi.fn()
    const { getByRole } = render(<TwinMark {...props} interactive={false} onOpen={() => {}} onMove={onMove} />)
    drag(getByRole('button'), [100, 100], [140, 130])
    expect(onMove).not.toHaveBeenCalled()
  })
})
