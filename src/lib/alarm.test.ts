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
class FakeCtx {
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  currentTime = 0
  destination = {}
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  createOscillator = vi.fn(() => (lastOsc = new FakeOsc()))
  createGain = vi.fn(() => (fakeGain = new FakeGain()))
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
