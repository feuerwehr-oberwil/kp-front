// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
})

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function boot(time = 0) {
  document.body.innerHTML = '<div class="boot-splash"><svg class="firefighter-snail" style="--snail-arrival-duration: 630ms"></svg></div>'
  const svg = document.querySelector('svg')!
  let finish!: () => void
  let cancel!: () => void
  const animation = {
    animationName: 'fs-arrival', currentTime: time,
    finished: new Promise<void>((resolve, reject) => { finish = resolve; cancel = () => reject(new Error('Cancelled')) }),
  }
  Object.defineProperty(svg, 'getAnimations', { configurable: true, value: vi.fn(() => [animation]) })
  return { svg, animation, finish, cancel }
}

function reactSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.style.setProperty('--snail-arrival-duration', '630ms')
  document.body.append(svg)
  const animations = [{ currentTime: 0 }, { currentTime: 0 }, { currentTime: 0 }]
  Object.defineProperty(svg, 'getAnimations', { value: vi.fn(() => animations) })
  return { svg, animations }
}

describe('snail launch', () => {
  it('keeps the entrance on screen when startup is ready before it finishes', async () => {
    const { finish } = boot()
    const { waitForSnailArrival } = await import('./snailLaunch')
    let ready = false
    const waiting = waitForSnailArrival().then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(130)
    finish()
    await waiting
    expect(ready).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('adds no arrival hold after a slow boot has already shown it', async () => {
    boot(2_000)
    const { waitForSnailArrival } = await import('./snailLaunch')
    const waiting = waitForSnailArrival()
    await vi.advanceTimersByTimeAsync(16)
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })

  it('continues the same clock through React handover and later loading stages', async () => {
    boot(2_000)
    const { waitForSnailArrival, continueSnailAnimation } = await import('./snailLaunch')
    const waiting = waitForSnailArrival()
    await vi.advanceTimersByTimeAsync(16)
    await waiting
    // React replaces the old boot DOM; its clock must survive that replacement.
    document.body.replaceChildren()
    const first = reactSvg()
    continueSnailAnimation(first.svg)
    expect(first.animations.map(a => a.currentTime)).toEqual([2_000, 2_000, 2_000])
    await vi.advanceTimersByTimeAsync(400)
    const next = reactSvg()
    continueSnailAnimation(next.svg)
    expect(next.animations.map(a => a.currentTime)).toEqual([2_400, 2_400, 2_400])
  })

  it('uses the running idle clock after the one-shot has stopped at its end', async () => {
    const { svg, animation } = boot(630)
    Object.defineProperty(svg, 'getAnimations', { value: vi.fn(() => [animation, { animationName: 'fs-shell', currentTime: 2_800 }]) })
    const { waitForSnailArrival, continueSnailAnimation } = await import('./snailLaunch')
    const waiting = waitForSnailArrival()
    await vi.advanceTimersByTimeAsync(16)
    await waiting
    const next = reactSvg()
    continueSnailAnimation(next.svg)
    expect(next.animations.map(a => a.currentTime)).toEqual([2_800, 2_800, 2_800])
  })

  it('starts in-workspace loaders at the idle instead of replaying the entrance', async () => {
    const { continueSnailAnimation } = await import('./snailLaunch')
    const { svg, animations } = reactSvg()
    continueSnailAnimation(svg, true)
    expect(animations.map(a => a.currentTime)).toEqual([630, 630, 630])
  })

  it('skips the hold for reduced motion', async () => {
    boot()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { waitForSnailArrival } = await import('./snailLaunch')
    await waitForSnailArrival()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can mount without boot markup', async () => {
    const { waitForSnailArrival } = await import('./snailLaunch')
    await waitForSnailArrival()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wedge startup when an animation is cancelled', async () => {
    const { cancel } = boot()
    const { waitForSnailArrival } = await import('./snailLaunch')
    const waiting = waitForSnailArrival()
    await vi.advanceTimersByTimeAsync(16)
    cancel()
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the hold even if neither a frame nor an animation completion arrives', async () => {
    boot()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    const { waitForSnailArrival } = await import('./snailLaunch')
    let ready = false
    const waiting = waitForSnailArrival().then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(729)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(ready).toBe(true)
  })
})
