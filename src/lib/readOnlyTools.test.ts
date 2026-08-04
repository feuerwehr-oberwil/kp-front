import { describe, it, expect } from 'vitest'
import { slimTools, MAP_READONLY_TOOLS, PLAN_READONLY_TOOLS } from './readOnlyTools'
import { appConfig } from '../config/appConfig'

describe('slimTools', () => {
  it('keeps only the allowed tools, in rail order', () => {
    const out = slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS)
    expect(out.filter((t) => !('sep' in t && t.sep)).map((t) => t.id)).toEqual(['select', 'measure'])
  })

  it('drops the Symbol slot marker (a create tool has no read-only form)', () => {
    const out = slimTools(appConfig.copy.mapTools, MAP_READONLY_TOOLS)
    expect(out.some((t) => 'slot' in t && t.slot)).toBe(false)
  })

  it('never opens or closes on a separator', () => {
    const tools = [
      { id: 'sep-a', sep: true },
      { id: 'select' },
      { id: 'line' },
      { id: 'sep-b', sep: true },
      { id: 'measure' },
      { id: 'sep-c', sep: true },
    ]
    const out = slimTools(tools, MAP_READONLY_TOOLS)
    expect(out.map((t) => t.id)).toEqual(['select', 'sep-b', 'measure'])
  })

  it('collapses runs of separators left behind by dropped tools', () => {
    const tools = [
      { id: 'select' },
      { id: 'sep-a', sep: true },
      { id: 'line' },
      { id: 'sep-b', sep: true },
      { id: 'measure' },
    ]
    expect(slimTools(tools, MAP_READONLY_TOOLS).map((t) => t.id)).toEqual(['select', 'sep-b', 'measure'])
  })

  it('covers the plan rail too — pan is the plan Auswahl', () => {
    const out = slimTools(appConfig.copy.planTools, PLAN_READONLY_TOOLS)
    expect(out.filter((t) => !('sep' in t && t.sep)).map((t) => t.id)).toEqual(['pan', 'measure'])
  })

  it('no allowed tool present → an empty rail, not a bare divider', () => {
    expect(slimTools([{ id: 'sep', sep: true }, { id: 'line' }], MAP_READONLY_TOOLS)).toEqual([])
  })
})
