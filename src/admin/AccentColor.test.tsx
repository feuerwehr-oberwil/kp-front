// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Akzentfarbe, and the rule it had none of: the field was free text with no check anywhere.
// «nicht-eine-farbe» was answered with 200 and «Gespeichert», the swatch went black, and the
// value went on to the login screen, the splash, the manifest's `theme_color` and the Rapport
// letterhead. The map centre one field below has had a range guard AND plain-language help for
// months.
//
// Two halves, and the second is the one that matters at 3am: a colour that is ALREADY STORED
// and no longer passes must not lock the station out of its own config page.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))

import { ConfigProvider } from './ConfigContext'
import { AccentColorField } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.identity

const swatch = () => document.querySelector<HTMLInputElement>('input[type=color]')!
const box = () => document.querySelector<HTMLInputElement>('.adm-input-mono')!
const type = (value: string) => act(async () => { fireEvent.change(box(), { target: { value } }) })

/** `identity.accentColor` of the most recent PUT body. */
const sentColor = () => {
  const last = apiPut.mock.calls[apiPut.mock.calls.length - 1]
  return (last?.[1] as { identity?: { accentColor?: unknown } })?.identity?.accentColor
}

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })

const EMPTY = { identity: { appName: 'Feuerwehr Steintal', accentColor: null }, version: 'v1' }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(EMPTY)
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(cfg: unknown = EMPTY) {
  apiGet.mockResolvedValue(cfg)
  render(<ConfigProvider><AccentColorField /></ConfigProvider>)
  await waitFor(() => expect(document.querySelectorAll('input').length).toBe(2))
}

describe('Akzentfarbe — a colour, or nothing', () => {
  it('sends a hex colour, normalised the way the API stores it', async () => {
    await setup()
    await type('#1D6F5C')
    await settle()
    expect(sentColor()).toBe('#1d6f5c')
  })

  it('never sends something that is not a colour — and says why on screen', async () => {
    await setup()
    await type('nicht-eine-farbe')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.accentColorInvalid)).toBeTruthy()
    // …and the value stays on screen to be corrected, rather than being silently thrown away
    expect(box().value).toBe('nicht-eine-farbe')
  })

  it('the swatch shows the colour that is actually live, never black for a non-colour', async () => {
    await setup()
    await type('nicht-eine-farbe')
    expect(swatch().value).toBe('#e8392b') // the fallback --accent, not #000000
    await type('#abc')
    expect(swatch().value).toBe('#aabbcc') // the short form, expanded — the picker needs six
  })

  it('accepts a half-typed colour on the way to a whole one', async () => {
    await setup()
    await type('#e83')
    await settle()
    expect(sentColor()).toBe('#e83') // 3-digit hex IS a colour
    await type('#e8392b')
    await settle()
    expect(sentColor()).toBe('#e8392b')
  })

  it('clearing the field unsets the colour instead of storing an empty string', async () => {
    await setup({ identity: { accentColor: '#1d6f5c' }, version: 'v1' })
    await type('')
    await settle()
    expect(sentColor()).toBeNull()
  })

  it('a colour already stored that no longer passes does not break the page', async () => {
    // The lock-out case: an older row still holds one. It is shown, it is flagged, and — the
    // point — the field does not re-send it, so the rest of the page keeps saving.
    await setup({ identity: { accentColor: 'nicht-eine-farbe' }, version: 'v1' })
    expect(box().value).toBe('nicht-eine-farbe')
    expect(screen.getByText(C.accentColorInvalid)).toBeTruthy()
    expect(swatch().value).toBe('#e8392b')
    await settle()
    expect(apiPut).not.toHaveBeenCalled() // nothing was edited, so nothing is written back
    // one correction and the document is savable again
    await type('#1d6f5c')
    await settle()
    expect(sentColor()).toBe('#1d6f5c')
  })
})
