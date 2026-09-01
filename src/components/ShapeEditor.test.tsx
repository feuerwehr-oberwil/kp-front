// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShapeEditor } from './ShapeEditor'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

const noop = () => {}

describe('ShapeEditor · Stopp-Balken toggle (arrow only)', () => {
  it('offers the toggle for an arrow and reports the flipped value', () => {
    const onStop = vi.fn()
    render(<ShapeEditor entity={{ shape: 'arrow' }} onColor={noop} onStop={onStop} onDelete={noop} onClose={noop} />)
    expect(screen.getByText(appConfig.copy.shapes.stopLabel)).toBeTruthy()
    const toggle = screen.getByRole('button', { name: appConfig.copy.drawingEditor.off })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(onStop).toHaveBeenCalledWith(true)
  })

  it('shows an active bar as An and turns it back off', () => {
    const onStop = vi.fn()
    render(<ShapeEditor entity={{ shape: 'arrow', stop: true }} onColor={noop} onStop={onStop} onDelete={noop} onClose={noop} />)
    const toggle = screen.getByRole('button', { name: appConfig.copy.drawingEditor.on })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onStop).toHaveBeenCalledWith(false)
  })

  it('never offers the row for the other shapes — they have no tip to stop at', () => {
    render(<ShapeEditor entity={{ shape: 'square' }} onColor={noop} onStop={noop} onDelete={noop} onClose={noop} />)
    expect(screen.queryByText(appConfig.copy.shapes.stopLabel)).toBeNull()
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
