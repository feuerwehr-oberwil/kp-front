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
// a statechange – the order a real tablet reports it in.
let ctx: FakeCtx | undefined
class FakeCtx {
  state = 'suspended'
  private listeners = new Set<() => void>()
  constructor() { ctx = this } // eslint-disable-line @typescript-eslint/no-this-alias -- the test needs the instance the lib builds
  resume = vi.fn(async () => { this.state = 'running'; this.dispatch() })
  addEventListener = (type: string, fn: () => void) => { if (type === 'statechange') this.listeners.add(fn) }
  dispatch() { for (const fn of this.listeners) fn() }
}
;(globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx

// lib/alarm keeps its context for the page's life: each test starts from a fresh page's state –
// audio taken away again (as a phone call does), no mute stored
beforeEach(() => {
  vi.mocked(useIsPhone).mockReturnValue(false)
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
/** a finger's tap; the context's async statechange lands between the press and the click */
const tap = async (el: Element) => {
  fireEvent.pointerDown(el)
  await act(async () => {})
  fireEvent.pointerUp(el)
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
