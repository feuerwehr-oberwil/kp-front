// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** a fresh module per test: the marks are module state, one launch per page */
const load = async () => { vi.resetModules(); return import('./bootTiming') }

describe('reportBoot', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

  it('sends one line when the splash is gone, with the boot marks and the lift', async () => {
    const { markBoot, reportBoot } = await load()
    document.body.innerHTML = '<div id="root"><div class="login splash boot-splash"></div></div>'
    const send = vi.fn()
    reportBoot(send, 'abc1234')
    markBoot('root')
    document.getElementById('root')!.innerHTML = '<div class="login splash"></div>'
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    document.getElementById('root')!.innerHTML = '<main></main>'
    await Promise.resolve()
    document.getElementById('root')!.innerHTML = '<main>again</main>'
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send).toHaveBeenCalledTimes(1)
    const body = send.mock.calls[0][0]
    expect(body).toMatchObject({ build: 'abc1234', standalone: false, marks: { nosw: 1, upd: 0 } })
    expect(Object.keys(body.marks)).toEqual(expect.arrayContaining(['entry', 'root', 'lift']))
  })

  it('flags a launch that went to the background before its line went out', async () => {
    const { reportBoot } = await load()
    document.body.innerHTML = '<div id="root"><div class="login splash boot-splash"></div></div>'
    const send = vi.fn()
    reportBoot(send, 'x')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    document.getElementById('root')!.innerHTML = '<main></main>'
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0].marks.hid).toBe(1)
    visibility.mockRestore()
  })

  it('places the worker\'s own marks on the page\'s timeline', async () => {
    const { reportBoot } = await load()
    const postMessage = vi.fn((_: unknown, [port]: MessagePort[]) => {
      port.postMessage({ evalAt: performance.timeOrigin - 2_000, navAt: performance.timeOrigin + 40 })
    })
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller: { postMessage } } })
    document.body.innerHTML = '<div id="root"><div class="login splash boot-splash"></div></div>'
    const send = vi.fn()
    reportBoot(send, 'x')
    document.getElementById('root')!.innerHTML = '<main></main>'
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    // a worker already running from an earlier page: started 2 s before this navigation
    expect(send.mock.calls[0][0].marks).toMatchObject({ swe: -2_000, swn: 40, nosw: 0 })
    vi.unstubAllGlobals()
  })

  it('still reports a launch whose splash never lifts, after 30 s', async () => {
    const { reportBoot } = await load()
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"><div class="login splash boot-splash"></div></div>'
    const send = vi.fn()
    reportBoot(send, 'x')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].marks.lift).toBeUndefined()
  })

  it('carries the opening cover\'s marks: the line goes out when the cover\'s splash is gone', async () => {
    const { reportBoot } = await load()
    const { BOOT_COVER_FADE_MS, useBootCover } = await import('./bootCover')
    document.body.innerHTML = '<div id="root"></div><div class="login splash"></div>'
    const send = vi.fn()
    reportBoot(send, 'x')
    const lift = () => document.querySelector('.splash')?.remove()
    const { rerender } = renderHook(({ wx }) => useBootCover(true, { sym: true, wx }, lift), { initialProps: { wx: false } })
    rerender({ wx: true })
    await act(async () => { await new Promise((r) => setTimeout(r, BOOT_COVER_FADE_MS + 20)) })
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    const { marks } = send.mock.calls[0][0]
    expect(marks).toMatchObject({ sym: expect.any(Number), wx: expect.any(Number), cover: expect.any(Number), lift: expect.any(Number) })
    expect(marks.cap).toBeUndefined()
  })

  it('a kiosk\'s cold start: the line leaves at the PIN pad, the cover\'s marks follow in a late line', async () => {
    const { markBoot, reportBoot } = await load()
    document.body.innerHTML = '<div id="root"><div class="login splash boot-splash"></div></div>'
    const send = vi.fn()
    reportBoot(send, 'k1')
    document.getElementById('root')!.innerHTML = '<div class="pinpad"></div>'
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].marks.cover).toBeUndefined()
    // the PIN typed: the Einsatz opens behind its cover (lib/bootCover)
    markBoot('sym'); markBoot('wx')
    expect(send).toHaveBeenCalledTimes(1)
    markBoot('cover')
    expect(send).toHaveBeenCalledTimes(2)
    const late = send.mock.calls[1][0]
    expect(late).toMatchObject({ nav: 'late', build: 'k1' })
    expect(Object.keys(late.marks)).toEqual(['sym', 'wx', 'cover'])
    markBoot('cover'); markBoot('later')
    expect(send).toHaveBeenCalledTimes(2)
  })
})
