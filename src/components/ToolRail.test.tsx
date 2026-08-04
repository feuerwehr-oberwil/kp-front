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
