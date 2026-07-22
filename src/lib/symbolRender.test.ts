import { describe, expect, it } from 'vitest'
import { luefterVariant, LUEFTER, LUEFTER_EXTRACT } from './symbolRender'
import { symbolControls } from './symbols'

describe('luefterVariant — Lüfter airflow direction', () => {
  it('swaps the mobile Lüfter to the reversed-arrow glyph only when extract is set', () => {
    expect(luefterVariant(LUEFTER, true)).toBe(LUEFTER_EXTRACT)
    expect(luefterVariant(LUEFTER, false)).toBe(LUEFTER)
    expect(luefterVariant(LUEFTER, undefined)).toBe(LUEFTER)
  })

  it('never touches other symbols, even with extract set', () => {
    expect(luefterVariant('VKF Feuer', true)).toBe('VKF Feuer')
    expect(luefterVariant('Grosslüfter', true)).toBe('Grosslüfter')
    expect(luefterVariant(undefined, true)).toBeUndefined()
  })

  it('offers the airflow control on the mobile Lüfter (and not on a plain symbol)', () => {
    expect(symbolControls(LUEFTER).has('airflow')).toBe(true)
    expect(symbolControls('VKF Feuer').has('airflow')).toBe(false)
  })
})
