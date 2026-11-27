// @vitest-environment jsdom
// «Beschriftung» set in the home's Einstellungen reaches a surface that reads it with
// useRailLabels (the Karte's rail) at once – the sheet sits over that surface, nothing remounts.
// …and «Gerät auf Standard zurücksetzen» reaches every holder of a device pref the same way.
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { loadPrefs, savePrefs } from './prefs'
import { resetDevicePrefs, useDevicePrefs, useRailLabels } from './useDevicePrefs'

afterEach(() => { cleanup(); document.cookie = 'kp-front-prefs=; max-age=0; path=/' })

it('a change in the Einstellungen shows on a useRailLabels reader without a remount', () => {
  let set: ((v: 'off' | 'short') => void) | null = null
  const Sheet = () => { set = useDevicePrefs().setRailLabels; return null }
  const Rail = () => <span data-testid="labels">{useRailLabels()}</span>
  render(<><Sheet /><Rail /></>)
  expect(screen.getByTestId('labels').textContent).toBe('short')
  act(() => set!('off'))
  expect(screen.getByTestId('labels').textContent).toBe('off')
})

it('a reset puts every holder back on the defaults, and its undo brings the choices back', () => {
  savePrefs({ symbolScaleMap: 1.3, keepScreenOn: false, railLabels: 'off', railLabelsChosen: true, theme: 'night', incidentId: 'e1' })
  const Holder = () => {
    const p = useDevicePrefs()
    return <span data-testid="p">{`${p.symbolScale.map} ${p.keepScreenOn} ${p.railLabels}`}</span>
  }
  const Rail = () => <span data-testid="rail">{useRailLabels()}</span>
  render(<><Holder /><Rail /></>)
  expect(screen.getByTestId('p').textContent).toBe('1.3 false off')

  let undo: () => void = () => {}
  act(() => { undo = resetDevicePrefs() })
  // the default is the words on every device (M8 A) – a reset lands there
  expect(screen.getByTestId('p').textContent).toBe('1 true short')
  expect(screen.getByTestId('rail').textContent).toBe('short')
  expect(loadPrefs()).toEqual({ incidentId: 'e1' })

  act(() => undo())
  expect(screen.getByTestId('p').textContent).toBe('1.3 false off')
  expect(screen.getByTestId('rail').textContent).toBe('off')
  expect(loadPrefs().theme).toBe('night')
})

it('a useRailLabels reader parses the prefs cookie once, not on every render – again after a write', () => {
  // a cookie string no other test writes, so nothing is cached for it yet
  savePrefs({ railLabels: 'off', railLabelsChosen: true, incidentId: 'parse-count' })
  const parse = vi.spyOn(JSON, 'parse')
  const { result, rerender } = renderHook(useRailLabels)
  for (let i = 0; i < 99; i++) rerender()
  expect(result.current).toBe('off')
  expect(parse).toHaveBeenCalledTimes(1)
  // a write that does not announce itself (another tab, the workspace's own prefs effect) shows too
  act(() => { savePrefs({ railLabels: 'short', railLabelsChosen: true }) })
  rerender()
  expect(result.current).toBe('short')
  expect(parse).toHaveBeenCalledTimes(2)
  parse.mockRestore()
})
