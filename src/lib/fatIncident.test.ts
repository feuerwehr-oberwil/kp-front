import { describe, expect, it } from 'vitest'
import { FAT_PRESETS, fatIncident } from './fatIncident'
import { sanitizeWorkspace } from './workspace'
import { objectsFromLegacy } from './tacticalObjects'

const kb = (v: unknown) => Math.round(JSON.stringify(v).length / 1024)

describe('fatIncident', () => {
  it('is deterministic per seed', () => {
    expect(JSON.stringify(fatIncident({ seed: 7 }).workspace)).toBe(JSON.stringify(fatIncident({ seed: 7 }).workspace))
    expect(JSON.stringify(fatIncident({ seed: 7 }).workspace)).not.toBe(JSON.stringify(fatIncident({ seed: 8 }).workspace))
  })

  it.each(Object.keys(FAT_PRESETS) as (keyof typeof FAT_PRESETS)[])('%s passes the load gate untouched', (preset) => {
    const fat = fatIncident(FAT_PRESETS[preset])
    const gate = sanitizeWorkspace(JSON.parse(JSON.stringify(fat.workspace)))
    expect(gate.dropped).toBe(0)
    expect(gate.newerSchema).toBe(false)
  })

  it('carries the schema-2 objects exactly as the app unifies them', () => {
    const { workspace: ws } = fatIncident({ scale: 3 })
    expect(ws.objects).toEqual(objectsFromLegacy(ws.entities, ws.drawings, ws.board))
  })

  it('×1 over 5 h is the size of the busiest real incident', () => {
    const fat = fatIncident(FAT_PRESETS.real)
    // prod, 26.09.2026: the biggest blob without an in-blob Verlauf was 70 KB, the longest
    // Einsatz 1 458 saves / 1 754 events, the fullest Verlauf 233 journal rows
    expect(kb(fat.workspace)).toBeGreaterThan(40)
    expect(kb(fat.workspace)).toBeLessThan(160)
    expect(fat.saves).toBeGreaterThan(1300)
    expect(fat.events.length).toBeGreaterThan(1600)
    expect(fat.journal.length).toBeGreaterThan(250)
  })

  it('grows through the incident: stateAt(1) is the final blob, earlier states are smaller', () => {
    const fat = fatIncident({ scale: 2 })
    expect(fat.stateAt(1)).toEqual(fat.workspace)
    expect(kb(fat.stateAt(0.25))).toBeLessThan(kb(fat.stateAt(0.75)))
    expect(fat.stateAt(0).trupps!.length).toBeLessThan(fat.workspace.trupps!.length)
  })

  it('keeps the audit chain in seq and time order', () => {
    const { events } = fatIncident({ hours: 2 })
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect([...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))).toEqual(events)
  })
})
