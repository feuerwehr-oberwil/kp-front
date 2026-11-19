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

describe('Üben · catalogue', () => {
  it('17 drills in three modules; «Als Nächstes» skips what is done and what cannot run yet', async () => {
    const { ALL_DRILLS, MODULES, nextDrill } = await import('./catalogue')
    expect(MODULES.map((m) => m.drills.length)).toEqual([5, 6, 6])
    expect(new Set(ALL_DRILLS).size).toBe(17)
    expect(nextDrill(new Set())).toBe('fahrzeugLeitung')
    expect(nextDrill(new Set(['fahrzeugLeitung']))).toBeNull()
  })
})
