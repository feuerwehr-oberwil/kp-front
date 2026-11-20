// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// the store reads localStorage once, at import – each test imports a fresh one
const fresh = async () => { vi.resetModules(); return import('./session') }

describe('Üben · progress per device', () => {
  beforeEach(() => localStorage.clear())

  it('a drill done here stays done across a reload; the running drill too', async () => {
    const a = await fresh()
    a.startDrill('fahrzeugLeitung')
    a.markDone('fahrzeugLeitung')
    const b = await fresh()
    expect(b.uebenState().done.has('fahrzeugLeitung')).toBe(true)
    expect(b.uebenState().drill).toBe('fahrzeugLeitung')
    b.stopDrill()
    expect((await fresh()).uebenState().drill).toBeNull()
  })

  it('starting the same drill again is a new run, and closes the sheet', async () => {
    const a = await fresh()
    a.openUebenSheet()
    a.startDrill('fahrzeugLeitung')
    const first = a.uebenState().run
    a.startDrill('fahrzeugLeitung')
    expect(a.uebenState().run).toBe(first + 1)
    expect(a.uebenState().sheetOpen).toBe(false)
  })

  it('ignores what it does not know in storage', async () => {
    localStorage.setItem('kp.ueben.drill', 'gibtsnicht')
    localStorage.setItem('kp.ueben.done', '["fahrzeugLeitung", 3, "x"]')
    const a = await fresh()
    expect(a.uebenState().drill).toBeNull()
    expect([...a.uebenState().done]).toEqual(['fahrzeugLeitung'])
  })
})

describe('Üben · without a drill', () => {
  it('«Ausprobieren» takes the drill off the card, names the surface once and closes the sheet', async () => {
    const a = await fresh()
    a.startDrill('fahrzeugLeitung')
    a.openUebenSheet()
    a.openFree('atemschutz')
    expect(a.uebenState()).toMatchObject({ drill: null, goTo: 'atemschutz', sheetOpen: false })
    a.clearGoTo()
    expect(a.uebenState().goTo).toBeNull()
    // not remembered: a reload opens the Übungsplatz where the device left it
    expect((await fresh()).uebenState()).toMatchObject({ drill: null, goTo: null })
  })
})

describe('Üben · catalogue', () => {
  it('one list: every drill has its copy, and «Als Nächstes» walks it and skips what is done', async () => {
    const { ALL_DRILLS, drillCopy, drillPlace, nextDrill } = await import('./catalogue')
    expect(new Set(ALL_DRILLS).size).toBe(ALL_DRILLS.length)
    for (const id of ALL_DRILLS) expect(drillCopy(id).title).toBeTruthy()
    expect(drillPlace(ALL_DRILLS[0])).toEqual({ i: 1, n: ALL_DRILLS.length })
    expect(nextDrill(new Set())).toBe(ALL_DRILLS[0])
    expect(nextDrill(new Set(ALL_DRILLS))).toBeNull()
  })
})
