// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useShareMyPosition } from './useShareMyPosition'
import { loadPrefs, savePrefs } from './prefs'

// The promises this hook makes are about NOT doing things — not reporting when nobody agreed,
// not reporting into a finished Einsatz, not starting again by itself at the next Einsatz, and
// not leaving a position behind after somebody stops. Those are the tests.

const INC = 'inc-1'
const P1 = 'person-1'

/** One geolocation fix, in the shape watchPosition hands over. */
const fix = (lng: number, lat: number, accuracy = 10): GeolocationPosition =>
  ({ coords: { longitude: lng, latitude: lat, accuracy }, timestamp: Date.now() }) as GeolocationPosition

/** Stub navigator.geolocation and return a handle that pushes fixes into the live watcher. */
function stubGeo() {
  let onFix: PositionCallback | null = null
  let onErr: PositionErrorCallback | null = null
  const clearWatch = vi.fn()
  vi.stubGlobal('navigator', {
    ...window.navigator,
    geolocation: {
      watchPosition: (ok: PositionCallback, err: PositionErrorCallback) => { onFix = ok; onErr = err; return 7 },
      clearWatch,
      getCurrentPosition: vi.fn(),
    },
  })
  return {
    clearWatch,
    push: (p: GeolocationPosition) => onFix?.(p),
    fail: (code: number) => onErr?.({ code, PERMISSION_DENIED: 1 } as GeolocationPositionError),
    get watching() { return onFix != null },
  }
}

function clearPrefs() {
  const p = loadPrefs()
  delete p.sharePosition
  savePrefs(p)
}

describe('useShareMyPosition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearPrefs()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearPrefs()
  })

  it('reports nothing at all until somebody switches it on', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    expect(result.current.state).toBe('off')
    expect(geo.watching).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).not.toHaveBeenCalled()
    unmount()
  })

  it('reports the first fix once a name is picked', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    expect(result.current.state).toBe('starting') // nothing reported yet — no green light
    await act(async () => { geo.push(fix(7.5, 47.5)) })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/incidents/${INC}/positions`)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ person_id: P1, display_name: 'Meier Hans', lat: 47.5, lng: 7.5 })
    expect(body.device_id).toMatch(/^dev-/)
    expect(result.current.state).toBe('on')
    unmount()
  })

  it('does not report into an Einsatz that is over', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Consent already given on this device from an earlier Einsatz — the point of a per-device
    // opt-in. It must still not report into a closed one.
    savePrefs({ ...loadPrefs(), sharePosition: { allowed: true, personId: P1, displayName: 'Meier Hans', deviceId: 'dev-aaaaaaaa' } })
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, false))

    expect(result.current.state).toBe('off')
    expect(geo.watching).toBe(false)
    unmount()
  })

  it('does NOT start by itself, however long the permission has been granted', async () => {
    // THE contract of the split. A phone that starts broadcasting because of something its
    // owner agreed to months ago is exactly what the permission/act separation prevents.
    const geo = stubGeo()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    savePrefs({ ...loadPrefs(), sharePosition: { allowed: true, personId: P1, displayName: 'Meier Hans', deviceId: 'dev-aaaaaaaa' } })
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    expect(result.current.state).toBe('off')
    expect(result.current.ready).toBe(true) // …but one tap away
    expect(geo.watching).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).not.toHaveBeenCalled()
    unmount()
  })

  it('starts on one tap once the name is confirmed FOR THIS Einsatz', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    savePrefs({ ...loadPrefs(), sharePosition: { allowed: true, personId: P1, displayName: 'Meier Hans', deviceId: 'dev-aaaaaaaa', confirmedIncidentId: INC } })
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    expect(result.current.confirmed).toBe(true)
    act(() => { result.current.start() }) // no argument — the compass-menu tap
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('on')
    unmount()
  })

  it('asks WHO AGAIN at the next Einsatz — a remembered name never starts by itself', async () => {
    // The shared Tablet. The device knows the name from the last Einsatz; that name must not
    // be reported into this one until somebody has confirmed it here.
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    savePrefs({ ...loadPrefs(), sharePosition: { allowed: true, personId: P1, displayName: 'Meier Hans', deviceId: 'dev-aaaaaaaa', confirmedIncidentId: 'inc-vorher' } })
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    expect(result.current.ready).toBe(true) // the device may use its position …
    expect(result.current.confirmed).toBe(false) // … but nobody said who is holding it here

    act(() => { result.current.start() }) // the one-tap path — must do nothing at all
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(result.current.state).toBe('off')
    expect(fetchMock).not.toHaveBeenCalled()

    // …and the picker's tap is what unlocks it, under the name that was actually picked
    act(() => { result.current.start({ id: 'person-2', displayName: 'Weber Anna' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).person_id).toBe('person-2')
    unmount()
  })

  it('does not ask again when the SAME Einsatz is reopened', async () => {
    // Re-opening the app mid-Einsatz must not put a roster list in front of somebody at 3am:
    // the confirmation is persisted, so it survives the reload it was made in.
    const geo = stubGeo()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const first = renderHook(() => useShareMyPosition(INC, true))
    act(() => { first.result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    first.unmount()

    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))
    expect(result.current.confirmed).toBe(true)
    expect(result.current.state).toBe('off') // sharing is still an act, switched on per Einsatz
    act(() => { result.current.start() })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(result.current.state).toBe('on')
    unmount()
  })

  it('is off again at the NEXT Einsatz — switched on for one, not for all', async () => {
    const geo = stubGeo()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const { result, rerender, unmount } = renderHook(
      ({ inc }: { inc: string }) => useShareMyPosition(inc, true),
      { initialProps: { inc: INC } },
    )
    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(result.current.state).toBe('on')

    rerender({ inc: 'inc-2' })
    expect(result.current.state).toBe('off')
    expect(result.current.ready).toBe(true) // the permission survives; the act does not
    expect(result.current.confirmed).toBe(false) // …and neither does «das bin ich»
    unmount()
  })

  it('stopping keeps the permission — stopping is not revoking', async () => {
    const geo = stubGeo()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    await act(async () => { result.current.stop() })

    expect(result.current.state).toBe('off')
    expect(result.current.ready).toBe(true)
    // …and it is still THIS Einsatz, so switching back on is one tap, not a roster list again
    expect(result.current.confirmed).toBe(true)
    expect(loadPrefs().sharePosition?.allowed).toBe(true)
    unmount()
  })

  it('revoking withdraws the permission and stops', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    fetchMock.mockClear()
    await act(async () => { result.current.revoke() })

    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE') // the dot goes at once
    expect(result.current.state).toBe('off')
    expect(result.current.ready).toBe(false)
    expect(loadPrefs().sharePosition?.allowed).toBe(false)
    // granting it again has to ask who this device is, not resume under the old name
    expect(loadPrefs().sharePosition?.confirmedIncidentId).toBeUndefined()
    unmount()
  })

  it('DELETES the position when sharing stops — the dot must go, not age', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    fetchMock.mockClear()

    await act(async () => { result.current.stop() })
    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('DELETE')
    expect(url).toContain(`/api/incidents/${INC}/positions/${P1}`)
    expect(url).toContain('device=') // one phone must not switch off another's sharing
    expect(result.current.state).toBe('off')
    unmount()
  })

  it('throttles: a phone standing still reports on the heartbeat, not per fix', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // three more fixes from the same spot, seconds apart
    await act(async () => { geo.push(fix(7.5, 47.5)); geo.push(fix(7.5, 47.5)); geo.push(fix(7.5, 47.5)) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('reports at once when the phone has actually moved (the drive to the Weiher)', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    // ~1.5 km east, well past minMoveM — must not wait out the 20 s heartbeat
    await act(async () => { geo.push(fix(7.52, 47.5)) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('drops a fix too vague to draw', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    // a 2 km accuracy circle rendered as a dot is a lie — indoors that is what a phone reports
    await act(async () => { geo.push(fix(7.5, 47.5, 2000)) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toBe('starting')
    unmount()
  })

  it('says «pausiert», not «geteilt», when the browser stops delivering fixes', async () => {
    const geo = stubGeo()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })
    expect(result.current.state).toBe('on')

    // the phone goes in a pocket: the watch simply stops calling back
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(result.current.state).toBe('paused')
    unmount()
  })

  it('surfaces a denied permission instead of pretending to share', async () => {
    const geo = stubGeo()
    vi.stubGlobal('fetch', vi.fn())
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.fail(1) })
    expect(result.current.state).toBe('denied')
    unmount()
  })

  it('stands down when another phone already shares that name, keeping the consent', async () => {
    const geo = stubGeo()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useShareMyPosition(INC, true))

    act(() => { result.current.start({ id: P1, displayName: 'Meier Hans' }) })
    await act(async () => { geo.push(fix(7.5, 47.5)) })

    expect(result.current.state).toBe('taken')
    expect(geo.clearWatch).toHaveBeenCalled() // stop rather than fight over the name
    // the permission survives, so picking a different name doesn't re-run the whole consent
    expect(result.current.pref?.allowed).toBe(true)
    unmount()
  })
})
