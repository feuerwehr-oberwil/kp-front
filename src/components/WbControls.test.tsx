// @vitest-environment jsdom
// The open draft's dashes stand still under a finger on the Plan, as on the Karte (lib/draftAnts):
// WbInkLayer marks its layer `.held` while any pointer is down on the board, and lets go on the
// last pointerup / pointercancel (09-whiteboard · .wb-ink-svg.held pauses the march).
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { BoardPoint } from '../types'
import { WbInkLayer } from './WbControls'

const draft: BoardPoint[] = [[0.1, 0.1], [0.5, 0.5]]
const board = (draftOpen: boolean) => render(
  <div className="wb-canvas">
    <div className="wb-ink" />
    <WbInkLayer annos={[]} draft={draft} draftFloor={0} draftOpen={draftOpen} color="#000" width={3} dashed={false}
      hiddenTrails={new Set()} mapY={(_f, y) => y} sW={400} sH={300} />
  </div>)

afterEach(cleanup)

describe('the open draft under a finger', () => {
  it('holds from the first pointerdown on the board to the last pointerup', () => {
    const { container } = board(true)
    const layer = container.querySelector('.wb-ink-svg')!
    const ink = container.querySelector('.wb-ink')!
    expect(container.querySelector('.wb-draft-open')).not.toBeNull()
    expect(layer.classList.contains('held')).toBe(false)
    fireEvent.pointerDown(ink, { pointerId: 1 })
    fireEvent.pointerDown(ink, { pointerId: 2 })
    expect(layer.classList.contains('held')).toBe(true)
    // the up lands wherever the captured pointer is – the window hears it
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(layer.classList.contains('held')).toBe(true)
    fireEvent.pointerCancel(window, { pointerId: 2 })
    expect(layer.classList.contains('held')).toBe(false)
  })

  it('marks nothing while no open drawing marches', () => {
    const { container } = board(false)
    fireEvent.pointerDown(container.querySelector('.wb-ink')!, { pointerId: 1 })
    expect(container.querySelector('.wb-ink-svg')!.classList.contains('held')).toBe(false)
  })
})
