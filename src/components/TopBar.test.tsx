// @vitest-environment jsdom
import { Profiler, type ComponentProps } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatTime } from '../lib/format'
import { fmtClock } from '../lib/atemschutz'
import { TopBar, windArrowRotation } from './TopBar'
import { installHoldTooltip } from '../lib/holdTooltip'
import { loadPrefs, savePrefs } from '../lib/prefs'
import type { Incident } from '../types'

afterEach(() => {
  cleanup(); vi.useRealTimers()
  savePrefs({ ...loadPrefs(), railLabels: undefined, railLabelsChosen: undefined })
})

const INCIDENT: Incident = {
  type: 'Brand', title: 'Brand Hauptstrasse', address: 'Hauptstrasse 1', center: [7.55, 47.51],
  startedAt: '2026-11-06T10:00:00Z', durationSec: 0, offline: false, cachedTiles: 0, recording: false, recDurationSec: 0,
}
const STARTED = '2026-11-06T10:00:00Z'
const bar = () => render(<TopBar incident={INCIDENT} startedAt={STARTED} recording={false} recStartedAt={null} journalOpen={false}
  onToggleJournal={vi.fn()} onAddEntry={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canUndo={false} canRedo={false} />)
/** the bar inside a Profiler: `commits()` counts every commit of the bar and what it renders */
function profiledBar(props: Partial<ComponentProps<typeof TopBar>> = {}) {
  let n = 0
  const all = (p: Partial<ComponentProps<typeof TopBar>>) => (
    <Profiler id="bar" onRender={() => { n++ }}>
      <TopBar incident={INCIDENT} startedAt={STARTED} recording={false} recStartedAt={null} journalOpen={false}
        onToggleJournal={vi.fn()} onAddEntry={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canUndo={false} canRedo={false} {...p} />
    </Profiler>
  )
  const view = render(all(props))
  return { commits: () => n, rerender: (p: Partial<ComponentProps<typeof TopBar>>) => view.rerender(all({ ...props, ...p })) }
}
/** let `ms` pass, one second at a time, each in its own act (one act would batch the ticks) */
const pass = (ms: number) => { for (let t = 0; t < ms; t += 1000) act(() => { vi.advanceTimersByTime(Math.min(1000, ms - t)) }) }
const letters = () => [...document.querySelectorAll('.tb-act .tb-key')].map((el) => el.textContent)

// S6 (staging review 06.11.2026): Verlauf and Eintrag are listed with their keys like the rail tiles
describe('the top bar\'s shortcut letters', () => {
  it('Verlauf wears J and Eintrag E, and both tooltips name the key', () => {
    bar()
    expect(letters()).toEqual(['J', 'E'])
    expect(screen.getByRole('button', { name: /Verlauf/ }).title).toBe('Verlauf – Taste J')
    expect(screen.getByRole('button', { name: 'Eintrag' }).title).toMatch(/– Taste E$/)
  })
})

// Üben feedback (owner 27.11.2026): «Beschriftung der Werkzeugleisten: Aus» takes the actions'
// words as it takes the rails'. The word is not rendered at all – the hold-tooltip names only a
// button that shows no text (lib/holdTooltip · labelOf) – and stays the button's name.
describe('the top bar with the words off', () => {
  const actions = () => [...document.querySelectorAll<HTMLButtonElement>('.tb-act')]
  const withHistory = () => render(<TopBar incident={INCIDENT} startedAt={STARTED} recording={false} recStartedAt={null} journalOpen={false}
    onToggleJournal={vi.fn()} onAddEntry={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canUndo={false} canRedo={false} showHistory />)
  it('words on: ↶ ↷ Verlauf Eintrag wear their words', () => {
    withHistory()
    expect(actions().map((b) => b.textContent)).toEqual(['Rückgängig', 'Wiederherstellen', 'VerlaufJ', 'EintragE'])
  })
  it('words off: each is its glyph (the key letter aside), named as before', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    withHistory()
    expect(document.querySelector('.topbar')!.hasAttribute('data-bare')).toBe(true)
    expect(actions().map((b) => b.textContent)).toEqual(['', '', 'J', 'E'])
    expect(actions().map((b) => b.getAttribute('aria-label') ?? b.title)).toEqual(['Rückgängig', 'Wiederherstellen', 'Verlauf', 'Eintrag'])
  })
  // owner, Üben feedback 27.11.2026 («Yes, hold names them»): the bare Verlauf is a panel door
  // whose glyph does not say what opens – a hold names it and opens nothing, a tap opens at once
  it('words off: a hold on Verlauf names it and opens nothing; a tap opens it', () => {
    vi.useFakeTimers()
    const uninstall = installHoldTooltip()
    try {
      const press = (el: Element, type: string) => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
        Object.defineProperty(e, 'pointerType', { value: 'touch' })
        el.dispatchEvent(e)
      }
      const onToggleJournal = vi.fn()
      for (const words of ['short', 'off'] as const) {
        savePrefs({ ...loadPrefs(), railLabels: words, railLabelsChosen: true })
        render(<TopBar incident={INCIDENT} startedAt={STARTED} recording={false} recStartedAt={null} journalOpen={false}
          onToggleJournal={onToggleJournal} onAddEntry={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canUndo={false} canRedo={false} showHistory />)
        const verlauf = screen.getByRole('button', { name: 'Verlauf' })
        press(verlauf, 'pointerdown')
        act(() => { vi.advanceTimersByTime(520) })
        // worded, the word already answers: no bubble, the release opens as ever
        expect(document.querySelector('.hold-tip')?.textContent).toBe(words === 'off' ? 'Verlauf' : undefined)
        press(verlauf, 'pointerup')
        fireEvent.click(verlauf)
        expect(onToggleJournal).toHaveBeenCalledTimes(words === 'off' ? 0 : 1)
        onToggleJournal.mockClear()
        press(verlauf, 'pointerdown')
        press(verlauf, 'pointerup')
        fireEvent.click(verlauf)
        expect(onToggleJournal).toHaveBeenCalledTimes(1)
        onToggleJournal.mockClear()
        act(() => { vi.advanceTimersByTime(2000) })
        cleanup()
      }
    } finally { uninstall() }
  })
})

// round 2b (owner 13.11.2026): the clock wears no label; a tap names it in a popover
describe('the Einsatzuhr', () => {
  it('shows hourglass and digits only, and a tap says «Einsatzdauer · seit …»', async () => {
    bar()
    const clock = screen.getByRole('button', { name: /^Einsatzdauer: / })
    expect(clock.textContent).not.toContain('Einsatzdauer')
    fireEvent.click(clock)
    expect(await screen.findByText(`Einsatzdauer · seit ${formatTime(new Date(STARTED))} Uhr`)).toBeTruthy()
  })

  // perf sweep 26.11.2026: the bar rendered every second for a clock that shows H:MM
  it('an idle minute costs the bar at most the one commit of the minute change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(STARTED) + 42 * 60_000 + 17_000)
    const { commits } = profiledBar()
    const before = commits()
    pass(60_000)
    expect(commits() - before).toBeLessThanOrEqual(2)
    expect(screen.getByRole('button', { name: /^Einsatzdauer: / }).textContent).toBe('0:43')
  })
})

// the two second-clocks are leaves of their own: they tick while they show, and the bar does not
describe('the bar\'s second-clocks', () => {
  it('the voice memo counts seconds while it records', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(STARTED) + 600_000)
    profiledBar({ recording: true, recStartedAt: Date.now() })
    expect(document.querySelector('.tb-act-add .tb-act-label')?.textContent).toBe('00:00')
    pass(3000)
    expect(document.querySelector('.tb-act-add .tb-act-label')?.textContent).toBe('00:03')
  })

  it('the Atemschutz chip ticks its contact clock from the moment the alarm shows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(STARTED) + 600_000)
    const { rerender } = profiledBar()
    const contactAt = Date.now() - 125_000
    rerender({ azAlarm: { peak: 2, severities: {}, urgent: { id: 't1', name: 'Trupp 1', sinceContactSec: 125, contactAt, severity: 2, reason: 'contact' } } })
    const clock = () => document.querySelector('.tb-az-clock')?.textContent
    expect(clock()).toBe(fmtClock(125))
    pass(2000)
    expect(clock()).toBe(fmtClock(127))
  })
})

// The bar's own «Teilen» button was removed on 06.09. — the Einsatz-Karte's «Teilen» row
// (panels/IncidentSwitcher) is now the one door to the share sheet on every width.

// The wind arrow's one piece of maths, kept here since WindBadge (its old home) was deleted as
// dead code on 05.09. — it aims the arrow DOWNWIND, and it has to follow the map's rotation.
describe('windArrowRotation', () => {
  it('rotates by the FROM bearing on a north-up map (aims the arrow downwind)', () => {
    expect(windArrowRotation(225)).toBe(225)
    expect(windArrowRotation(0)).toBe(0)
  })

  it('follows the map rotation by subtracting the bearing (like the compass needle)', () => {
    // map rotated 90° clockwise → the same wind reads 90° less on screen
    expect(windArrowRotation(225, 90)).toBe(135)
    expect(windArrowRotation(45, 45)).toBe(0)
    expect(windArrowRotation(10, 40)).toBe(-30)
  })
})
