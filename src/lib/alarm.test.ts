// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { primeAudio, startAlarm, stopAlarm } from './alarm'

const { ensurePushSubscription } = vi.hoisted(() => ({ ensurePushSubscription: vi.fn() }))
vi.mock('./push', () => ({ ensurePushSubscription }))

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

describe('alarm delivery and lifecycle', () => {
  let api: typeof import('./alarm')
  const alarms: import('./alarm').Alarm[] = []
  const makeAlarm = () => { const a = new api.Alarm(); alarms.push(a); return a }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.stubGlobal('AudioContext', function () { return (lastCtx = new FakeCtx()) })
    ensurePushSubscription.mockReset().mockResolvedValue(undefined)
    api = await import('./alarm')
  })
  afterEach(() => {
    alarms.splice(0).forEach((a) => a.stop())
    api.stopAlarm()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('changes from single warning pips to double critical pips, replacing the old cadence', () => {
    api.primeAudio()
    const a = makeAlarm()
    a.set(1)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(1)
    expect(lastOsc.frequency.value).toBe(820)
    a.set(1)
    vi.advanceTimersByTime(2399)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(2)
    a.set(2)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(4)
    expect(lastOsc.frequency.value).toBe(1100)
    vi.advanceTimersByTime(1499)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(1)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(6)
    a.set(0)
    vi.advanceTimersByTime(10_000)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(6)
  })

  it('schedules audible, separated critical pips through connected audio nodes', () => {
    api.primeAudio()
    lastCtx.currentTime = 5
    makeAlarm().set(2)
    const oscillators = lastCtx.createOscillator.mock.results.map((r) => r.value)
    const gains = lastCtx.createGain.mock.results.map((r) => r.value)
    expect(oscillators).toHaveLength(2)
    for (const [i, oscillator] of oscillators.entries()) {
      const gain = gains[i]
      expect(oscillator.type).toBe('square')
      expect(oscillator.connect).toHaveBeenCalledWith(gain)
      expect(gain.connect).toHaveBeenCalledWith(lastCtx.destination)
      const start = oscillator.start.mock.calls[0]?.[0] as number
      const stop = oscillator.stop.mock.calls[0]?.[0] as number
      expect(start).toBeGreaterThanOrEqual(5)
      expect(stop).toBeGreaterThan(start)
      const [attack, decay] = gain.gain.exponentialRampToValueAtTime.mock.calls
      const initial = gain.gain.setValueAtTime.mock.calls[0]
      expect(initial[0]).toBeGreaterThan(0)
      expect(initial[1]).toBe(start)
      expect(attack[0]).toBeGreaterThan(initial[0])
      expect(attack[1]).toBeGreaterThan(start)
      expect(decay[0]).toBeLessThanOrEqual(initial[0])
      expect(decay[1]).toBeGreaterThan(attack[1])
      expect(decay[1]).toBeLessThan(stop)
    }
    expect(oscillators[1].start.mock.calls[0][0]).toBeGreaterThan(oscillators[0].stop.mock.calls[0][0])
  })

  it('replaces the looping timer on escalation and disconnects the oscillator when stopped', () => {
    api.startAlarm('warn')
    const oscillator = lastOsc
    expect(oscillator.type).toBe('square')
    expect(oscillator.connect).toHaveBeenCalledWith(fakeGain)
    expect(fakeGain.connect).toHaveBeenCalledWith(lastCtx.destination)
    expect(vi.getTimerCount()).toBe(1)
    api.startAlarm('critical')
    expect(vi.getTimerCount()).toBe(1)
    const cancellations = fakeGain.gain.cancelScheduledValues.mock.calls.length
    lastCtx.currentTime = 1
    api.stopAlarm()
    expect(vi.getTimerCount()).toBe(0)
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
    expect(fakeGain.gain.cancelScheduledValues).toHaveBeenCalledTimes(cancellations + 1)
    expect(fakeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.0001, lastCtx.currentTime)
  })

  it('unlocks through the shared call-site alias without creating audio on a read-out', () => {
    expect(api.audioUnlocked()).toBe(false)
    api.unlockAlarm()
    expect(api.audioUnlocked()).toBe(true)
    expect(lastCtx.resume).toHaveBeenCalledTimes(1)
    api.primeAudio()
    expect(lastCtx.resume).toHaveBeenCalledTimes(1)
  })

  it('mutes and resumes an active alarm while retaining its screen wake lock', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue({ released: false, release })
    vi.stubGlobal('navigator', { wakeLock: { request }, vibrate: vi.fn() })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    api.primeAudio()
    const a = makeAlarm()
    a.set(2)
    await Promise.resolve()
    expect(request).toHaveBeenCalledExactlyOnceWith('screen')
    a.setMuted(true)
    vi.advanceTimersByTime(5000)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(2)
    expect(release).not.toHaveBeenCalled()
    a.setMuted(false)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(4)
    a.setMuted(false)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(4)
    a.stop()
    expect(release).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(4)
  })

  it('reacquires a released wake lock on foreground, and removes that listener when stopped', async () => {
    const sentinel = { released: false, release: vi.fn().mockResolvedValue(undefined) }
    const request = vi.fn().mockResolvedValue(sentinel)
    vi.stubGlobal('navigator', { wakeLock: { request } })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const a = makeAlarm()
    a.setMuted(true)
    a.set(1)
    expect(request).not.toHaveBeenCalled()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(request).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(request).toHaveBeenCalledTimes(1)
    sentinel.released = true
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
    a.stop()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('releases a wake lock that arrives after the alarm stopped', async () => {
    let accept!: (s: { released: boolean; release: () => Promise<void> }) => void
    const request = vi.fn(() => new Promise((resolve) => { accept = resolve }))
    const release = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { wakeLock: { request } })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const a = makeAlarm()
    a.setMuted(true)
    a.set(1)
    a.stop()
    accept({ released: false, release })
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('vibrates with the alarm tier and remains usable when vibration is blocked', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const a = makeAlarm()
    a.set(1)
    expect(vibrate).toHaveBeenLastCalledWith([90])
    a.set(2)
    expect(vibrate).toHaveBeenLastCalledWith([120, 90, 120])
    vibrate.mockImplementation(() => { throw new Error('blocked') })
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow()
  })

  it('uses the WebKit audio constructor and tolerates missing or rejected audio support', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    expect(api.primeAudio()).toBe(false)
    expect(() => api.startAlarm()).not.toThrow()
    expect(() => makeAlarm().set(2)).not.toThrow()
    vi.stubGlobal('webkitAudioContext', function () { return (lastCtx = new FakeCtx()) })
    expect(api.primeAudio()).toBe(true)
    lastCtx.state = 'closed'
    lastCtx.resume.mockRejectedValue(new Error('closed'))
    expect(api.primeAudio()).toBe(false)
    await Promise.resolve()
  })

  it('plays the optional chime only while audio is running, without changing the looping alarm', () => {
    api.chime()
    const c = lastCtx
    c.state = 'suspended'
    expect(c.createOscillator).not.toHaveBeenCalled()
    api.primeAudio()
    c.currentTime = 10
    api.startAlarm('warn')
    const loop = lastOsc
    api.chime()
    expect(lastOsc.type).toBe('sine')
    expect(lastOsc.frequency.value).toBe(660)
    expect(lastOsc.start).toHaveBeenCalledExactlyOnceWith(10)
    expect(lastOsc.stop).toHaveBeenCalledExactlyOnceWith(10.22)
    expect(loop.stop).not.toHaveBeenCalled()
    api.stopAlarm()
    const calls = c.createOscillator.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(c.createOscillator).toHaveBeenCalledTimes(calls)
  })

  it.each(['default', 'denied'] as const)('delivers nothing when notification permission is %s', async (permission) => {
    const Notification = vi.fn()
    Object.assign(Notification, { permission })
    vi.stubGlobal('Notification', Notification)
    const showNotification = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ showNotification }) } })
    expect(api.notificationsSupported()).toBe(true)
    expect(api.notificationsAllowed()).toBe(false)
    await api.notify('Kontakt')
    expect(showNotification).not.toHaveBeenCalled()
    expect(Notification).not.toHaveBeenCalled()
  })

  it('prefers service-worker notifications and carries the destination and coalescing options', async () => {
    const Notification = vi.fn()
    Object.assign(Notification, { permission: 'granted' })
    vi.stubGlobal('Notification', Notification)
    const showNotification = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ showNotification }) } })
    await api.notify('Kontakt', { body: 'Trupp 1', tag: 'trupp-1', target: '/incident/1' })
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('Kontakt', {
      body: 'Trupp 1', tag: 'trupp-1', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200], data: { target: '/incident/1' }, renotify: true,
    })
    expect(Notification).not.toHaveBeenCalled()
    await api.notify('Kontakt', { tag: 'trupp-1', renotify: false })
    expect(showNotification.mock.calls[1][1]).toMatchObject({ renotify: false })
    expect(showNotification.mock.calls[1][1]).not.toHaveProperty('data')
    await api.notify('Kontakt')
    expect(showNotification.mock.calls[2][1]).not.toHaveProperty('renotify')
  })

  it('falls back to a page notification after service-worker failure and tolerates a blocked fallback', async () => {
    const Notification = vi.fn(function () {})
    Object.assign(Notification, { permission: 'granted' })
    vi.stubGlobal('Notification', Notification)
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.reject(new Error('no worker')) } })
    await api.notify('Kontakt', { body: 'Trupp 1' })
    expect(Notification).toHaveBeenCalledExactlyOnceWith('Kontakt', expect.objectContaining({ body: 'Trupp 1' }))
    Notification.mockImplementation(function () { throw new Error('blocked') })
    vi.stubGlobal('navigator', {})
    await expect(api.notify('Kontakt')).resolves.toBeUndefined()
  })

  it.each(['granted', 'denied', 'default', 'unsupported'] as const)('requests permission only when undecided (%s)', async (permission) => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', permission === 'unsupported' ? undefined : { permission, requestPermission })
    expect(api.notificationsSupported()).toBe(permission !== 'unsupported')
    expect(api.notificationsAllowed()).toBe(permission === 'granted')
    expect(await api.ensureNotifyPermission()).toBe(permission === 'granted' || permission === 'default')
    expect(requestPermission).toHaveBeenCalledTimes(permission === 'default' ? 1 : 0)
    // Let the lazy push import settle before asserting the registration.
    await vi.dynamicImportSettled()
    expect(ensurePushSubscription).toHaveBeenCalledTimes(permission === 'granted' || permission === 'default' ? 1 : 0)
    if (permission === 'granted' || permission === 'default') expect(ensurePushSubscription).toHaveBeenCalledWith(true)
  })

  it('does not register push after permission is refused or the permission request fails', async () => {
    const requestPermission = vi.fn().mockResolvedValue('denied')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    expect(await api.ensureNotifyPermission()).toBe(false)
    requestPermission.mockRejectedValue(new Error('blocked'))
    expect(await api.ensureNotifyPermission()).toBe(false)
    expect(ensurePushSubscription).not.toHaveBeenCalled()
  })
})
