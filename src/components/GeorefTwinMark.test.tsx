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

describe('a read-only Georeferenz twin', () => {
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

  it('does not expose a draggable affordance', () => {
    const onOpen = vi.fn()
    const { getByRole } = render(<TwinMark {...props} onOpen={onOpen} />)
    const mark = getByRole('button')
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(mark, { pointerId: 1, clientX: 30, clientY: 30 })
    fireEvent.pointerUp(mark, { pointerId: 1, clientX: 35, clientY: 35 })
    expect(onOpen).not.toHaveBeenCalled()
    expect(mark.className).not.toContain('movable')
  })
})
