// @vitest-environment jsdom
// «Beschriftung» set in the home's Einstellungen reaches a surface that reads it with
// useRailLabels (the Karte's rail) at once – the sheet sits over that surface, nothing remounts.
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useDevicePrefs, useRailLabels } from './useDevicePrefs'

afterEach(() => { cleanup(); document.cookie = 'kp-front-prefs=; max-age=0; path=/' })

it('a change in the Einstellungen shows on a useRailLabels reader without a remount', () => {
  let set: ((v: 'off' | 'short') => void) | null = null
  const Sheet = () => { set = useDevicePrefs().setRailLabels; return null }
  const Rail = () => <span data-testid="labels">{useRailLabels(false)}</span>
  render(<><Sheet /><Rail /></>)
  expect(screen.getByTestId('labels').textContent).toBe('off')
  act(() => set!('short'))
  expect(screen.getByTestId('labels').textContent).toBe('short')
})
