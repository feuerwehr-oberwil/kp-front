// @vitest-environment jsdom
// M7 C (13.11.2026): «✓ Fertig» commits a draft and wears its word; the ✕ closes, at the dock's end.
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolDock } from './ToolDock'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

it('shows the commit as glyph + «Fertig», and keeps the ✕ last', () => {
  const commit = vi.fn()
  const { container } = render(<ToolDock groups={[[{ type: 'close', onClick: () => {} }], [{ type: 'go', onClick: commit }]]} />)
  const go = screen.getByRole('button', { name: appConfig.copy.done })
  expect(go.textContent).toBe(appConfig.copy.done)
  fireEvent.click(go)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(container.querySelector('.wb-dock')!.lastElementChild!.classList.contains('wb-dock-x')).toBe(true)
})
