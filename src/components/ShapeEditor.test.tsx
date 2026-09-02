// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShapeEditor } from './ShapeEditor'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

const noop = () => {}

// Both answers are on screen at once (the shared Segmented pair, 01.09.) — «An» is a button you
// can reach whatever the bar is doing, not the word a single chip happens to be showing.
describe('ShapeEditor · Stopp-Balken toggle (arrow only)', () => {
  const D = appConfig.copy.drawingEditor
  const seg = (name: string) => screen.getByRole('button', { name })

  it('offers the toggle for an arrow and reports the flipped value', () => {
    const onStop = vi.fn()
    render(<ShapeEditor entity={{ shape: 'arrow' }} onColor={noop} onStop={onStop} onDelete={noop} onClose={noop} />)
    expect(screen.getByText(appConfig.copy.shapes.stopLabel)).toBeTruthy()
    expect(seg(D.off).getAttribute('aria-pressed')).toBe('true')
    expect(seg(D.on).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(seg(D.on))
    expect(onStop).toHaveBeenCalledWith(true)
  })

  it('shows an active bar as An and turns it back off', () => {
    const onStop = vi.fn()
    render(<ShapeEditor entity={{ shape: 'arrow', stop: true }} onColor={noop} onStop={onStop} onDelete={noop} onClose={noop} />)
    expect(seg(D.on).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(seg(D.off))
    expect(onStop).toHaveBeenCalledWith(false)
  })

  it('never offers the row for the other shapes — they have no tip to stop at', () => {
    render(<ShapeEditor entity={{ shape: 'square' }} onColor={noop} onStop={noop} onDelete={noop} onClose={noop} />)
    expect(screen.queryByText(appConfig.copy.shapes.stopLabel)).toBeNull()
  })
})

// ⚠️ The size row hands its caller a ×-FACTOR and nothing else, because the two surfaces do not
// measure a Form in the same unit: the Karte writes metres into `sizeM`, a Plan — and a mirrored
// Form, which is edited through the Karte's own panel — a share of the sheet width into `sizeN`.
// One control, two units: it must never claim to know an absolute number.
describe('the size ± is a factor, not a value', () => {
  const S = appConfig.copy.shapes

  it('scales a Form up and down by the same step', () => {
    const onScale = vi.fn()
    render(<ShapeEditor entity={{ shape: 'square' }} onColor={noop} onScale={onScale} onDelete={noop} onClose={noop} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: S.sizeBigger }))
    fireEvent.pointerDown(screen.getByRole('button', { name: S.sizeSmaller }))
    expect(onScale.mock.calls).toEqual([[1.25], [1 / 1.25]])
  })

  it('asks a Rotation for its RUN instead — it has one size, and «Grösse» is not it', () => {
    const onScaleLength = vi.fn()
    render(<ShapeEditor entity={{ shape: 'rotation' }} onColor={noop} onScale={noop} onScaleLength={onScaleLength} onDelete={noop} onClose={noop} />)
    expect(screen.queryByText(S.size)).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: S.lengthLonger }))
    expect(onScaleLength).toHaveBeenCalledWith(1.25)
  })
})

describe('the twin’s one line of provenance', () => {
  const origin = () => screen.queryAllByRole('button', { name: appConfig.copy.whiteboard.georef.twinOrigin })

  it('is absent on a native Form and present on a mirrored one', () => {
    render(<ShapeEditor entity={{ shape: 'square' }} onColor={noop} onDelete={noop} onClose={noop} />)
    expect(origin()).toHaveLength(0)
    cleanup()
    const onOriginal = vi.fn()
    render(<ShapeEditor entity={{ shape: 'square' }} onColor={noop} onDelete={noop} onClose={noop} onOriginal={onOriginal} />)
    fireEvent.click(origin()[0])
    expect(onOriginal).toHaveBeenCalledTimes(1)
  })
})
