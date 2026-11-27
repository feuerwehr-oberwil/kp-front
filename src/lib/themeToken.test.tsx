// @vitest-environment jsdom
// themeToken reads a token off <html> once per theme, not once per render: on a dirty style tree
// each getComputedStyle is a forced style recalc. The day/night flip still lands in the same
// render, and a read before the stylesheet is there never pins the fallback.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTheme } from './prefs'
import { themeToken, uiBlue } from './themeToken'

const TOKENS: Record<'day' | 'night', Record<string, string>> = {
  day: { '--blue': '#1f6feb', '--ink-dim': '#424d5e', '--surface': '#fff' },
  night: { '--blue': '#5aa0ff', '--ink-dim': '#b4bfd0', '--surface': '#232c3a' },
}
/** the stylesheet is «loaded» once this is true; before, every token reads empty */
let stylesReady = true

beforeEach(() => {
  stylesReady = true
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
    const theme = document.documentElement.dataset.theme === 'night' ? 'night' : 'day'
    return { getPropertyValue: (n: string) => (stylesReady ? TOKENS[theme][n] ?? '' : '') } as CSSStyleDeclaration
  })
})
afterEach(() => { cleanup(); applyTheme('day'); vi.restoreAllMocks() })

const useTokens = () => [uiBlue(), themeToken('--ink-dim', '#000'), themeToken('--surface', '#fff')]

it('reads each token once per theme, however often the component renders', () => {
  // a read under another key first: whatever an earlier test cached is gone
  applyTheme('night'); uiBlue(); applyTheme('day')
  vi.mocked(window.getComputedStyle).mockClear()
  const { result, rerender } = renderHook(useTokens)
  expect(vi.mocked(window.getComputedStyle)).toHaveBeenCalledTimes(3)
  for (let i = 0; i < 99; i++) rerender()
  expect(result.current).toEqual(['#1f6feb', '#424d5e', '#fff'])
  expect(vi.mocked(window.getComputedStyle)).toHaveBeenCalledTimes(3)
})

it('the day/night flip lands in the first render after it, then is cached again', () => {
  const { result, rerender } = renderHook(useTokens)
  vi.mocked(window.getComputedStyle).mockClear()
  applyTheme('night')
  rerender()
  expect(result.current).toEqual(['#5aa0ff', '#b4bfd0', '#232c3a'])
  for (let i = 0; i < 50; i++) rerender()
  applyTheme('day')
  rerender()
  expect(result.current).toEqual(['#1f6feb', '#424d5e', '#fff'])
  expect(vi.mocked(window.getComputedStyle)).toHaveBeenCalledTimes(6)
})

it('an inline token on <html> (the deployment branding) is read again when it changes', () => {
  TOKENS.day['--accent'] = '#e8392b'
  vi.mocked(window.getComputedStyle).mockImplementation(() => ({
    getPropertyValue: (n: string) => (n === '--accent' ? document.documentElement.style.getPropertyValue('--accent') || TOKENS.day[n] : TOKENS.day[n] ?? ''),
  }) as CSSStyleDeclaration)
  expect(themeToken('--accent', '#000')).toBe('#e8392b')
  document.documentElement.style.setProperty('--accent', '#0a7')
  expect(themeToken('--accent', '#000')).toBe('#0a7')
  document.documentElement.style.removeProperty('--accent')
  delete TOKENS.day['--accent']
})

it('a read before the stylesheet is there gives the fallback but does not keep it', () => {
  TOKENS.day['--boot-only'] = '#424d5e' // read by no other test: nothing cached it before
  stylesReady = false
  expect(themeToken('--boot-only', '#000')).toBe('#000')
  stylesReady = true
  expect(themeToken('--boot-only', '#000')).toBe('#424d5e')
  delete TOKENS.day['--boot-only']
})
