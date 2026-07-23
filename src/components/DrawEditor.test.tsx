// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DrawEditor } from './DrawEditor'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

afterEach(cleanup)

const noop = () => {}
const base = {
  pointCount: 2,
  onPreset: noop, onColor: noop, onWidth: noop, onDashed: noop, onLabel: noop,
  onMarker: noop, onArrow: noop, onShowDistance: noop, onRadius: noop,
  onFillOpacity: noop, onDelete: noop, onClose: noop,
}

describe('shared magnetic connection controls', () => {
  it('shows both parties, touch actions, routing state and detach', () => {
    const onRouting = vi.fn(), onDetach = vi.fn(), onFocusAttachment = vi.fn()
    render(<DrawEditor {...base}
      drawing={{ kind: 'line', startAttachment: { target: { kind: 'object', id: 'pump' }, routing: 'direct' }, endAttachment: { target: { kind: 'line', id: 'l2', endpoint: 'end' }, routing: 'trace', port: 2 } }}
      attachmentLabels={{ start: 'TLF 1', end: 'Leitung 2' }}
      onRouting={onRouting} onDetach={onDetach} onFocusAttachment={onFocusAttachment} />)
    expect(screen.getByText('TLF 1')).toBeTruthy(); expect(screen.getByText('Leitung 2')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Spur' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Verbindung lösen' })[1])
    fireEvent.click(screen.getByRole('button', { name: /TLF 1/ })) // tap the target chip to fly there
    expect(onRouting).toHaveBeenCalledWith('start', 'trace')
    expect(onDetach).toHaveBeenCalledWith('end')
    expect(onFocusAttachment).toHaveBeenCalledWith('start')
  })

  it('uses the reviewed indirect-removal consequence copy', () => {
    expect(fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: 2 })).toBe('2 Linien werden gelöst.')
  })
})
