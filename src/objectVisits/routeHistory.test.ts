// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { appHistoryDepth, isWalkPop, leaveAppEntries, navigateTo, pushAppEntry, walkBack } from './route'

// iOS offers its edge-swipe back exactly when there is an entry to go back to (route · the ⚠️
// above `appHistoryDepth`). Leaving the Objektbesuche must therefore leave NOTHING behind the
// screen it returns to — not a replaced «/» entry per visit, as it did until 05.10.2026.
const popped = () => new Promise<void>((r) => window.addEventListener('popstate', () => r(), { once: true }))

describe('the app counts its own history entries', () => {
  it('walks back over every push when leaving, landing on the entry it was entered from', async () => {
    window.history.replaceState(null, '', '/')
    const floor = window.history.length
    expect(appHistoryDepth()).toBe(0)
    navigateTo('/besuche')
    navigateTo('/besuche?liste=fu')
    navigateTo('/besuche/v1', { replace: true }) // a replace keeps the depth
    pushAppEntry('/besuche/v1', { reader: true }) // the plan reader's entry is counted too
    expect(appHistoryDepth()).toBe(3)
    const done = popped()
    leaveAppEntries('/')
    await done
    expect(window.location.pathname).toBe('/')
    expect(appHistoryDepth()).toBe(0)
    // the entries are FORWARD now, not behind: nothing for a back swipe to reach
    expect(window.history.length).toBe(floor + 3)
  })

  it('with nothing pushed (a deep link at start) it replaces in place', () => {
    window.history.replaceState(null, '', '/besuche/v9')
    const len = window.history.length
    leaveAppEntries('/')
    expect(window.location.pathname).toBe('/')
    expect(window.history.length).toBe(len)
  })

  it('an entry from another page load (before a reload) is not counted', () => {
    window.history.replaceState({ kpDoc: 'earlier-load', kpDepth: 4 }, '', '/besuche')
    expect(appHistoryDepth()).toBe(0)
  })
})

// sweep 28.10.2026 #11 — iOS's swipe from the right edge is a forward traversal, offered exactly
// when a walk left entries forward (the Checkliste's levels after leaving them)
describe('never a step forward', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20))
  it('walks a forward traversal straight back, and no surface hears it as the user\'s', async () => {
    window.history.replaceState(null, '', '/')
    pushAppEntry('/')
    pushAppEntry('/')
    const heard: boolean[] = []
    const surface = (e: Event) => heard.push(isWalkPop(e))
    window.addEventListener('popstate', surface)
    const back = popped()
    walkBack(2)
    await back
    expect(appHistoryDepth()).toBe(0)
    heard.length = 0
    window.history.forward()
    await settle()
    await settle()
    expect(appHistoryDepth()).toBe(0)
    // the forward pop never reached the surface; the walk back did, as a walk
    expect(heard).toEqual([true])
    window.removeEventListener('popstate', surface)
  })

  it('keeps the native back: a step down is the user\'s, as before', async () => {
    window.history.replaceState(null, '', '/')
    pushAppEntry('/')
    const heard: boolean[] = []
    const surface = (e: Event) => heard.push(isWalkPop(e))
    window.addEventListener('popstate', surface)
    window.history.back()
    await settle()
    expect(appHistoryDepth()).toBe(0)
    expect(heard).toEqual([false])
    window.removeEventListener('popstate', surface)
  })
})
