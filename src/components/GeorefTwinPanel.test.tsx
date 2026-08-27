// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GeorefTwinPanel } from './GeorefTwinPanel'

afterEach(cleanup)

// The one rule this component exists to enforce: a Zwilling is a PROJECTION, so its panel shows
// everything and changes nothing. Dual-edit through a mirror is a merge case the workspace's
// per-object last-write-wins cannot resolve honestly (see the component header).
describe('a Zwilling\'s details', () => {
  const entity = {
    id: 'e1',
    symbol: 'VKF Feuer',
    label: 'Brandherd',
    fields: { Stockwerk: '2. OG' },
    notes: 'brennt im Estrich',
    count: 3,
  }

  it('shows what the source says and offers not one control that would change it', () => {
    const { container } = render(<GeorefTwinPanel entity={entity} subtitle="Gespiegelt von der Karte – nur zum Lesen"
      onClose={() => {}} onOriginal={() => {}} />)
    // Read-only is content behavior, not a second visual component: both source and twin use
    // exactly the same sidebar shell, dimensions, colour and mobile sheet rules.
    expect(container.querySelector('.ctx')?.className).toBe('ctx')
    expect(screen.getByText('Gespiegelt von der Karte – nur zum Lesen')).toBeTruthy()
    expect(screen.getByText('2. OG')).toBeTruthy()
    expect(screen.getByText('brennt im Estrich')).toBeTruthy()
    // nothing typeable, nothing to delete — the panel is a read-out
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Löschen' })).toBeNull()
  })

  it('leaves for the real object, and that is the only thing it does', () => {
    const onOriginal = vi.fn()
    render(<GeorefTwinPanel entity={entity} subtitle="Gespiegelt von Modul 2"
      onClose={() => {}} onOriginal={onOriginal} />)
    // the actions row is rendered twice (pinned + inline for phones; CSS shows exactly one)
    screen.getAllByRole('button', { name: /Zum Original/ })[0].click()
    expect(onOriginal).toHaveBeenCalledTimes(1)
  })

  it('can transfer ownership onto the viewed surface without unlocking a second copy', () => {
    const onTransferHere = vi.fn()
    render(<GeorefTwinPanel entity={entity} subtitle="Gespiegelt von Modul 2"
      onClose={() => {}} onOriginal={() => {}} onTransferHere={onTransferHere} />)
    screen.getAllByRole('button', { name: /Hierher übertragen/ })[0].click()
    expect(onTransferHere).toHaveBeenCalledTimes(1)
  })
})
