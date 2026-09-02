// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { primeAudio, startAlarm, stopAlarm } from './alarm'

// Minimal fake Web Audio graph — enough to assert wiring + lifecycle without real audio.
class FakeParam {
  value = 0
  setValueAtTime = vi.fn()
  cancelScheduledValues = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class FakeOsc {
  type = ''
  frequency = new FakeParam()
  start = vi.fn()
  stop = vi.fn()
  connect = vi.fn(() => fakeGain)
  disconnect = vi.fn()
}
class FakeGain {
  gain = new FakeParam()
  connect = vi.fn()
}
let lastOsc: FakeOsc
let fakeGain: FakeGain
let lastCtx: FakeCtx
class FakeCtx {
  // a string, not the lib's union: WebKit reports the non-standard 'interrupted'
  state = 'suspended'
  currentTime = 0
  destination = {}
  private listeners = new Set<() => void>()
  resume = vi.fn(async () => {
    this.state = 'running'
    this.dispatch()
  })
  createOscillator = vi.fn(() => (lastOsc = new FakeOsc()))
  createGain = vi.fn(() => (fakeGain = new FakeGain()))
  addEventListener = vi.fn((type: string, fn: () => void) => { if (type === 'statechange') this.listeners.add(fn) })
  /** what the browser does on every state transition */
  dispatch() { for (const fn of this.listeners) fn() }
}

describe('alarm utility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx as unknown as typeof AudioContext
  })
  afterEach(() => {
    stopAlarm()
    vi.useRealTimers()
    delete (globalThis as { AudioContext?: unknown }).AudioContext
  })

  it('primeAudio resumes a suspended context (autoplay unlock)', () => {
    expect(primeAudio()).toBe(true)
  })

  // The bell is only allowed to claim «Alarm an» while the tone can actually be heard, so this
  // read-out has to be honest about a context that does not exist yet — and it must never CREATE
  // one, or a surface that merely renders would spawn AudioContexts.
  it('audioUnlocked is false until something unlocks audio, and never creates a context', async () => {
    vi.resetModules()
    const fresh = await import('./alarm')
    expect(fresh.audioUnlocked()).toBe(false)
    expect(fresh.audioUnlocked()).toBe(false) // still nothing built by asking
    fresh.primeAudio()
    expect(fresh.audioUnlocked()).toBe(true)
  })

  it('startAlarm builds + starts an oscillator and loops beats', () => {
    startAlarm('warn')
    expect(lastOsc.start).toHaveBeenCalledTimes(1)
    expect(lastOsc.frequency.setValueAtTime).toHaveBeenCalledWith(660, 0)
    const beatsBefore = lastOsc.frequency.value // not used, just ensure no throw
    void beatsBefore
    // advance time → the interval fires more beep envelopes
    const rampCalls = fakeGain.gain.exponentialRampToValueAtTime.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(fakeGain.gain.exponentialRampToValueAtTime.mock.calls.length).toBeGreaterThan(rampCalls)
  })

  it('escalating to critical re-tunes without creating a second oscillator', () => {
    startAlarm('warn')
    const osc1 = lastOsc
    startAlarm('critical')
    expect(lastOsc).toBe(osc1) // same oscillator reused
    expect(osc1.frequency.setValueAtTime).toHaveBeenCalledWith(920, 0)
  })

  it('stopAlarm stops the oscillator and is safe to double-call', () => {
    startAlarm()
    const osc1 = lastOsc
    stopAlarm()
    expect(osc1.stop).toHaveBeenCalled()
    expect(() => stopAlarm()).not.toThrow()
  })
})

// A fresh module per test: `ctx` is module state, and these tests need a context of their own
// to put into a state the lib did not choose — so the constructor hands the instance out.
describe('alarm — an interrupted context', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    ;(globalThis as { AudioContext?: unknown }).AudioContext = function () { return (lastCtx = new FakeCtx()) }
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { AudioContext?: unknown }).AudioContext
  })

  it('pip resumes a context WebKit left «interrupted» (a call, Siri), not only a suspended one', async () => {
    const fresh = await import('./alarm')
    fresh.primeAudio()
    const c = lastCtx
    await Promise.resolve() // the unlock's resume settles
    expect(c.state).toBe('running')
    c.resume.mockClear()
    c.state = 'interrupted'
    const a = new fresh.Alarm()
    a.set(2) // überfällig → the first pip fires at once
    expect(c.resume).toHaveBeenCalledTimes(1)
    a.stop()
  })

  it('onAudioState hears every statechange, and an unsubscribed listener hears nothing', async () => {
    const fresh = await import('./alarm')
    const seen = vi.fn()
    const off = fresh.onAudioState(seen) // subscribed BEFORE any context exists, like the bell
    fresh.primeAudio()
    await Promise.resolve()
    expect(seen).toHaveBeenCalledTimes(1) // suspended → running
    expect(fresh.audioUnlocked()).toBe(true)
    lastCtx.state = 'interrupted'
    lastCtx.dispatch()
    expect(seen).toHaveBeenCalledTimes(2)
    expect(fresh.audioUnlocked()).toBe(false) // …and the bell reads the truth
    off()
    lastCtx.dispatch()
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
