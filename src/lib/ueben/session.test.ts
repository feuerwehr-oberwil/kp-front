// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// the store reads localStorage once, at import – each test imports a fresh one
const fresh = async () => { vi.resetModules(); return import('./session') }

describe('Üben · progress per device', () => {
  beforeEach(() => localStorage.clear())

  it('a step done here stays done across a reload; the running step too', async () => {
    const a = await fresh()
    a.startDrill('leitung')
    a.markDone('leitung')
    const b = await fresh()
    expect(b.uebenState().done.has('leitung')).toBe(true)
    expect(b.uebenState().drill).toBe('leitung')
    b.stopDrill()
    expect((await fresh()).uebenState().drill).toBeNull()
  })

  it('starting the same step again is a new run, and closes the sheet', async () => {
    const a = await fresh()
    a.openUebenSheet()
    a.startDrill('leitung')
    const first = a.uebenState().run
    a.startDrill('leitung')
    expect(a.uebenState().run).toBe(first + 1)
    expect(a.uebenState().sheetOpen).toBe(false)
  })

  it('only a start from the sheet shows the topic\'s intro card', async () => {
    const a = await fresh()
    a.startDrill('fahrzeug', { intro: true })
    expect(a.uebenState().intro).toBe(true)
    a.startDrill('leitung')
    expect(a.uebenState().intro).toBe(false)
  })

  it('ignores what it does not know in storage', async () => {
    localStorage.setItem('kp.ueben.drill', 'gibtsnicht')
    localStorage.setItem('kp.ueben.done', '["leitung", 3, "x"]')
    const a = await fresh()
    expect(a.uebenState().drill).toBeNull()
    expect([...a.uebenState().done]).toEqual(['leitung'])
  })
})

describe('Üben · without a step', () => {
  it('«Ausprobieren» takes the step off the card, names the surface once and closes the sheet', async () => {
    const a = await fresh()
    a.startDrill('leitung')
    a.openUebenSheet()
    a.openFree('atemschutz')
    expect(a.uebenState()).toMatchObject({ drill: null, goTo: 'atemschutz', sheetOpen: false })
    a.clearGoTo()
    expect(a.uebenState().goTo).toBeNull()
    // not remembered: a reload opens the Übungsplatz where the device left it
    expect((await fresh()).uebenState()).toMatchObject({ drill: null, goTo: null })
  })
})
