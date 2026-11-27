// @vitest-environment jsdom
// The bell against the REAL audio path: lib/alarm (armOnAnyTap, primeAudio), useAtemschutzMute
// and the AtemschutzView bell, with only the AudioContext faked. Üben clip 5.4 (27.11.2026): one
// tap on «Ton freigeben» left the bell on «Stumm» – the press primed the tone, the bell re-rendered
// as armed, and the same tap's click then muted it. Shared setup: AtemschutzView.setup.tsx.
import { useEffect } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AtemschutzView } from './AtemschutzView'
import { useIsPhone } from '../lib/useIsPhone'
import { armOnAnyTap } from '../lib/alarm'
import { useAtemschutzMute } from '../lib/useAtemschutzMute'
import s from './Atemschutz.module.css'
import { registerAtemschutzViewHooks, az, propsFor } from './AtemschutzView.setup'

vi.mock('../lib/useIsPhone', async (original) => ({ ...await original<typeof import('../lib/useIsPhone')>(), useIsPhone: vi.fn(() => false) }))
registerAtemschutzViewHooks()

// The browser's context: suspended until a gesture resumes it, and resume() answers later with
// a statechange – the order a real tablet reports it in. A mouse press activates on the press, a
// finger only on the lift (`gesture`: whether the event being dispatched may unlock audio).
let gesture = true
class FakeCtx {
  state = 'suspended'
  private listeners = new Set<() => void>()
  resume = vi.fn(async () => { if (!gesture) return; this.state = 'running'; this.dispatch() })
  addEventListener = (type: string, fn: () => void) => { if (type === 'statechange') this.listeners.add(fn) }
  dispatch() { for (const fn of this.listeners) fn() }
}
// the constructor hands the instance out: the tests put the lib's context back to `suspended`
let ctx: FakeCtx | undefined
;(globalThis as { AudioContext?: unknown }).AudioContext = function () { return (ctx = new FakeCtx()) }

// lib/alarm keeps its context for the page's life: each test starts from a fresh page's state –
// audio taken away again (as a phone call does), no mute stored
beforeEach(() => {
  vi.mocked(useIsPhone).mockReturnValue(false)
  gesture = true
  localStorage.clear()
  if (ctx) { ctx.state = 'suspended'; ctx.dispatch() }
})

/** What IncidentWorkspace + App wire around the board: the mute hook and the tap-anywhere arming. */
function Board() {
  const m = useAtemschutzMute('inc1')
  useEffect(() => armOnAnyTap(() => {}), [])
  return <AtemschutzView {...propsFor({ muted: m.muted, onToggleMuted: m.toggle, audioBlocked: m.audioBlocked, onUnlockAudio: m.unlockAudio })} />
}

const bell = () => document.querySelector<HTMLButtonElement>(`.${s.muteBtn}`)!
/** the bell's word – its honest state: «Alarmton» / «Stumm» / «Ton freigeben» */
const word = () => bell().textContent
/** a mouse click: the press unlocks, and the context's statechange lands before the click */
const tap = async (el: Element) => {
  fireEvent.pointerDown(el, { pointerType: 'mouse' })
  await act(async () => {})
  fireEvent.pointerUp(el, { pointerType: 'mouse' })
  fireEvent.click(el)
}
/** a finger: only the lift unlocks, and the statechange lands between the lift and the click */
const touchTap = async (el: Element) => {
  gesture = false
  fireEvent.pointerDown(el, { pointerType: 'touch' })
  gesture = true
  fireEvent.pointerUp(el, { pointerType: 'touch' })
  await act(async () => {})
  fireEvent.click(el)
}

describe('the bell\'s «Ton freigeben»', () => {
  // the phone head folds the bell into a tile with its word under the glyph – the same button
  it.each([['tablet', false], ['phone', true]])('one tap unlocks the tone and leaves it on – it never mutes (%s)', async (_, phone) => {
    vi.mocked(useIsPhone).mockReturnValue(phone)
    render(<Board />)
    expect(word()).toBe(az.alarmBlockedWord)
    await tap(bell())
    expect(word()).toBe(az.alarmWord)
    expect(bell().getAttribute('aria-pressed')).toBe('false')
  })

  it('a finger\'s tap, unlocked on the lift, leaves the tone on too', async () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    render(<Board />)
    await touchTap(bell())
    expect(word()).toBe(az.alarmWord)
  })

  // Sol review: a press that never got its click must not decide a later click with no press
  it('a cancelled press is forgotten – a later click with no press (VoiceOver) mutes', async () => {
    render(<Board />)
    fireEvent.pointerDown(bell(), { pointerType: 'mouse' })
    await act(async () => {})
    fireEvent.pointerCancel(bell())
    expect(word()).toBe(az.alarmWord)
    fireEvent.click(bell())
    expect(word()).toBe(az.alarmMutedWord)
  })

  it('a right-click leaves no press behind – a later click with no press mutes', async () => {
    render(<Board />)
    // the right press finds the bell blocked (and, like any press, unlocks the tone)…
    fireEvent.pointerDown(bell(), { pointerType: 'mouse', button: 2 })
    await act(async () => {})
    fireEvent.pointerUp(bell(), { pointerType: 'mouse', button: 2 })
    expect(word()).toBe(az.alarmWord)
    // …but fires no click; a later click with no press reads the bell as it is now: mute
    fireEvent.click(bell())
    expect(word()).toBe(az.alarmMutedWord)
  })

  it('a press released off the bell is forgotten too – a later click with no press mutes', async () => {
    render(<Board />)
    fireEvent.pointerDown(bell(), { pointerType: 'mouse' })
    await act(async () => {})
    fireEvent.pointerUp(document.body, { pointerType: 'mouse' })
    fireEvent.click(bell())
    expect(word()).toBe(az.alarmMutedWord)
  })

  it('a held Space (its repeats come after the unlock) still unlocks and does not mute', async () => {
    render(<Board />)
    fireEvent.keyDown(bell(), { key: ' ' })
    await act(async () => {})
    fireEvent.keyDown(bell(), { key: ' ', repeat: true })
    fireEvent.keyUp(bell(), { key: ' ' })
    fireEvent.click(bell())
    expect(word()).toBe(az.alarmWord)
  })

  it('a later tap on «Alarmton» still mutes', async () => {
    render(<Board />)
    await tap(bell())
    await tap(bell())
    expect(word()).toBe(az.alarmMutedWord)
  })

  it('a tap anywhere else still unlocks the tone, and the bell then says «Alarmton»', async () => {
    render(<Board />)
    await tap(document.body)
    expect(word()).toBe(az.alarmWord)
  })

  it('Space on the bell (keydown primes, the click comes with the keyup) unlocks and does not mute', async () => {
    render(<Board />)
    fireEvent.keyDown(bell(), { key: ' ' })
    await act(async () => {})
    fireEvent.keyUp(bell(), { key: ' ' })
    fireEvent.click(bell())
    expect(word()).toBe(az.alarmWord)
  })
})
