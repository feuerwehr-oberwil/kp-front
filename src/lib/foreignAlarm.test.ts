import { describe, expect, it } from 'vitest'
import { foreignMark, loudForeignAlarms, worksLiveErnstfall } from './foreignAlarm'
import type { IncidentMeta } from './incidents'
import { appConfig } from '../config/appConfig'

const inc = (id: string, over: Partial<IncidentMeta> = {}): IncidentMeta => ({
  id, title: id, status: 'offen', source: 'manual', started_at: `2026-11-13T0${id.length}:00:00Z`, is_archived: false,
  is_exercise: false, workspace_rev: 0, created_at: '', updated_at: '', ...over,
} as IncidentMeta)
const overdue = [{ id: 't1', name: 'Muster Leo', reason: 'contact' as const }]

// FLOW.1 (owner, 13.11.2026): two real Einsätze in parallel must not distract each other
describe('another Einsatz\'s Atemschutz alarm', () => {
  const brand = inc('brand', { atemschutz_due: overdue })
  const uebung = inc('uebung', { is_exercise: true, atemschutz_due: overdue })

  it('marks every running Einsatz with a Trupp at the alarm tier, a Notfall by its own word', () => {
    const c = appConfig.copy.atemschutz.foreign
    expect(foreignMark(brand)).toEqual({ word: c.mark, names: 'Atemschutz: Muster Leo' })
    expect(foreignMark(uebung)?.word).toBe(c.mark)
    expect(foreignMark(inc('nf', { atemschutz_due: [{ id: 't', name: 'A', reason: 'notfall' }] }))?.word).toBe(c.markNotfall)
    expect(foreignMark(inc('quiet'))).toBeNull()
    // a closed one alarms nothing, whatever a stale list says
    expect(foreignMark({ ...brand, is_archived: true })).toBeNull()
  })

  it('a device in a live Ernstfall raises nothing more than the mark', () => {
    const here = inc('bma')
    expect(worksLiveErnstfall(here)).toBe(true)
    expect(loudForeignAlarms([here, brand, uebung], here)).toEqual([])
  })

  it('a device in an Übung or a closed Einsatz raises a live Ernstfall\'s alarm — never an Übung\'s', () => {
    for (const here of [inc('drill', { is_exercise: true }), inc('done', { is_archived: true })]) {
      expect(worksLiveErnstfall(here)).toBe(false)
      expect(loudForeignAlarms([here, brand, uebung, brand], here).map((i) => i.id)).toEqual(['brand'])
    }
    // …its own alarm is its workspace's, never a second «foreign» one
    expect(loudForeignAlarms([{ ...uebung, id: 'drill2' }], { ...uebung, id: 'drill2' })).toEqual([])
  })
})
