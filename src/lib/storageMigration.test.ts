import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { idbGet, __resetIdbForTests } from './idb'
import { migrateLocalStorageToIdb } from './storageMigration'

function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  installLocalStorage()
})

describe('migrateLocalStorageToIdb', () => {
  it('moves operational keys into IDB (parsed) and clears them from localStorage', async () => {
    localStorage.setItem('kp-front-incidents', JSON.stringify([{ id: 'i1' }]))
    localStorage.setItem('kp-front-ws-abc', JSON.stringify({ workspace: { a: 1 }, baseRev: 2, dirty: true, lastSyncedAt: null }))
    localStorage.setItem('kp.osm.bld.1,2,3,4', JSON.stringify([[[0, 0], [1, 1]]]))
    localStorage.setItem('kp-front-user', JSON.stringify({ id: 'u1' }))
    localStorage.setItem('kp-front-roster', JSON.stringify([{ id: 'p1' }]))
    localStorage.setItem('kp-front-deployment-config', JSON.stringify({ identity: { name: 'X' } }))

    await migrateLocalStorageToIdb()

    // operational state now lives in IDB, as structured objects (not JSON strings)
    expect(await idbGet('kp-front-incidents')).toEqual([{ id: 'i1' }])
    expect(await idbGet('kp-front-ws-abc')).toMatchObject({ baseRev: 2, dirty: true, workspace: { a: 1 } })
    expect(await idbGet('kp.osm.bld.1,2,3,4')).toEqual([[[0, 0], [1, 1]]])
    expect(await idbGet('kp-front-user')).toEqual({ id: 'u1' })
    expect(await idbGet('kp-front-roster')).toEqual([{ id: 'p1' }])
    expect(await idbGet('kp-front-deployment-config')).toEqual({ identity: { name: 'X' } })

    // and the moved keys are gone from localStorage (no drift between the two stores)
    expect(localStorage.getItem('kp-front-incidents')).toBeNull()
    expect(localStorage.getItem('kp-front-ws-abc')).toBeNull()
    expect(localStorage.getItem('kp-front-deployment-config')).toBeNull()

    // flag is set so it never runs again
    expect(localStorage.getItem('kp-front-idb-migrated-v1')).toBe('1')
  })

  it('leaves device prefs and migration flags in localStorage', async () => {
    localStorage.setItem('kp.atemschutz.alarmMute', '1')
    localStorage.setItem('kp.divera.dismissed', '[1,2]')
    localStorage.setItem('kp-front-migrated-v1', '1')

    await migrateLocalStorageToIdb()

    expect(localStorage.getItem('kp.atemschutz.alarmMute')).toBe('1')
    expect(localStorage.getItem('kp.divera.dismissed')).toBe('[1,2]')
    expect(localStorage.getItem('kp-front-migrated-v1')).toBe('1')
    // these are not operational state, so they were not copied into IDB
    expect(await idbGet('kp.atemschutz.alarmMute')).toBeNull()
  })

  it('is idempotent — a second run (flag already set) moves nothing', async () => {
    localStorage.setItem('kp-front-idb-migrated-v1', '1')
    localStorage.setItem('kp-front-incidents', JSON.stringify([{ id: 'late' }]))

    await migrateLocalStorageToIdb()

    expect(await idbGet('kp-front-incidents')).toBeNull() // short-circuited, not moved
    expect(localStorage.getItem('kp-front-incidents')).not.toBeNull()
  })

  it('skips a corrupt entry without aborting the rest of the migration', async () => {
    localStorage.setItem('kp-front-ws-bad', '{not json')
    localStorage.setItem('kp-front-roster', JSON.stringify([{ id: 'p1' }]))

    await migrateLocalStorageToIdb()

    expect(await idbGet('kp-front-roster')).toEqual([{ id: 'p1' }]) // good entry still migrated
    expect(await idbGet('kp-front-ws-bad')).toBeNull() // corrupt entry not migrated
    expect(localStorage.getItem('kp-front-ws-bad')).toBe('{not json') // left in place, not removed
    expect(localStorage.getItem('kp-front-idb-migrated-v1')).toBe('1')
  })
})
