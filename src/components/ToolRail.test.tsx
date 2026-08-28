// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolRail } from './ToolRail'
import { appConfig } from '../config/appConfig'
import { slimTools, MAP_READONLY_TOOLS } from '../lib/readOnlyTools'

afterEach(cleanup)

// The rail a locked surface gets is the SAME component with a smaller tool list — same place,
// same look, same footer. What must never appear is a tool that writes.
describe('the read-only tool rail', () => {
  const renderSlim = (onPick = vi.fn()) => {
    render(<ToolRail
      className="tool-rail"
      primary={appConfig.copy.primarySymbol}
      tools={slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS)}
      active="select"
      onPick={onPick}
      footer={<button>{appConfig.copy.nav.zoomIn}</button>}
    />)
    return onPick
  }

  it('offers Auswahl and Messen', () => {
    renderSlim()
    expect(screen.getByRole('button', { name: 'Auswahl' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Messen' })).toBeTruthy()
  })

  it('offers nothing that would change the Lage', () => {
    renderSlim()
    for (const label of ['Symbol', 'Linie', 'Fläche', 'Absperrkreis', 'Notiz', 'Trupp', 'Mehrfach']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('keeps the pinned footer — a viewer still needs to zoom and reach Ebenen', () => {
    renderSlim()
    expect(screen.getByRole('button', { name: appConfig.copy.nav.zoomIn })).toBeTruthy()
  })

  it('picks by the same ids the editor rail uses', () => {
    const onPick = renderSlim()
    fireEvent.click(screen.getByRole('button', { name: 'Messen' }))
    expect(onPick).toHaveBeenCalledWith('measure')
  })
})

// «Einstellungen · Leisten-Beschriftung» says «Wort unter jedem Zeichen in den BEIDEN Leisten».
// It reached the Lage rail and not the Plan's, because Whiteboard rendered this same component
// without the prop — one setting, two rails, one of them not listening. The class is what the
// stylesheet keys the words off, so it is what gets pinned here.
describe('the Beschriftung device preference', () => {
  const renderRail = (labels?: 'off' | 'short') =>
    render(<ToolRail
      className="tool-rail"
      primary={appConfig.copy.primarySymbol}
      tools={appConfig.copy.mapTools}
      active="select"
      onPick={vi.fn()}
      labels={labels}
      footer={<button>{appConfig.copy.nav.zoomIn}</button>}
    />)

  it('carries the labelled class when the preference is on', () => {
    const { container } = renderRail('short')
    expect(container.querySelector('.vrail.labelled')).toBeTruthy()
  })

  it('does not when it is off, or absent', () => {
    const { container } = renderRail('off')
    expect(container.querySelector('.vrail.labelled')).toBeNull()
    cleanup()
    const bare = renderRail()
    expect(bare.container.querySelector('.vrail.labelled')).toBeNull()
  })

  it('renders the word for every tool either way — the stylesheet decides if it shows', () => {
    // the label element must EXIST unconditionally; .labelled only flips its display
    renderRail('short')
    expect(screen.getByRole('button', { name: 'Messen' }).querySelector('.vrail-label')?.textContent)
      .toBe('Messen')
  })
})

// The Karte and every Modul mount their own ToolRail, but the operator reads them as ONE
// sidebar — an expansion made on one surface survives the remount on the next.
it('keeps its expanded state across a remount (surface switch)', () => {
  const props = () => ({
    className: 'tool-rail',
    primary: appConfig.copy.primarySymbol,
    tools: slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS),
    active: 'select',
    onPick: vi.fn(),
    footer: <button>{appConfig.copy.nav.zoomIn}</button>,
  })
  const first = render(<ToolRail {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Ausklappen' }))
  expect(document.querySelector('.vrail.expanded')).toBeTruthy()
  first.unmount()
  render(<ToolRail {...props()} />)
  expect(document.querySelector('.vrail.expanded')).toBeTruthy()
  // …and collapsing writes back, so the next mount starts closed again
  fireEvent.click(screen.getByRole('button', { name: 'Einklappen' }))
  expect(document.querySelector('.vrail.expanded')).toBeNull()
})
