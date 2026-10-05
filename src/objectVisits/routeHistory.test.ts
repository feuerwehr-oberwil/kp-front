// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { appHistoryDepth, leaveAppEntries, navigateTo, pushAppEntry } from './route'

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
