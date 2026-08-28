// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GeorefTwinPanel } from './GeorefTwinPanel'

afterEach(cleanup)

describe('a Zwilling\'s source-backed editor', () => {
  const entity = {
    id: 'e1',
    symbol: 'VKF Fahrzeug',
    label: 'TLF 1',
    fields: { Fahrer: 'Muster Max' },
    notes: 'Bereitstellung Nord',
  }

  const setup = (over: Partial<React.ComponentProps<typeof GeorefTwinPanel>> = {}) => {
    const props: React.ComponentProps<typeof GeorefTwinPanel> = {
      entity,
      subtitle: 'Gespiegelt von der Karte',
      onClose: vi.fn(),
      onOriginal: vi.fn(),
      onTitle: vi.fn(),
      onFields: vi.fn(),
      onDelete: vi.fn(),
      titleOptions: ['TLF 1', 'TLF 2'],
      ...over,
    }
    render(<GeorefTwinPanel {...props} />)
    return props
  }

  it('keeps the mirrored provenance and exposes the normal editing controls', () => {
    const props = setup()
    expect(screen.getByText('Gespiegelt von der Karte')).toBeTruthy()
    fireEvent.click(document.querySelector('.ctx-title-btn')!)
    fireEvent.click(screen.getByText('TLF 2'))
    expect(props.onTitle).toHaveBeenCalledWith('TLF 2')
    expect(screen.getAllByRole('button', { name: 'Löschen' })).toHaveLength(2)
  })

  it('still offers navigation to the source without making it a prerequisite for editing', () => {
    const props = setup()
    screen.getAllByRole('button', { name: /Zum Original/ })[0].click()
    expect(props.onOriginal).toHaveBeenCalledTimes(1)
  })

  it('can transfer ownership onto the viewed surface', () => {
    const onTransferHere = vi.fn()
    setup({ onTransferHere })
    screen.getAllByRole('button', { name: /Hierher übertragen/ })[0].click()
    expect(onTransferHere).toHaveBeenCalledTimes(1)
  })

  it('keeps a genuinely locked session read-only while retaining the indicator', () => {
    setup({ readOnly: true })
    expect(screen.getByText('Gespiegelt von der Karte')).toBeTruthy()
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Löschen' })).toBeNull()
  })
})
