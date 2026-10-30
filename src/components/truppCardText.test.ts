import { describe, expect, it } from 'vitest'
import { appConfig } from '../config/appConfig'
import { deriveTruppLive } from '../lib/atemschutz'
import type { Trupp } from '../types'
import { tabState } from './truppCardText'

const az = appConfig.copy.atemschutz
const NOW = Date.parse('2026-10-30T12:00:00Z')
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't', name: 'Schmid Peter', entryPressureBar: 300, entryTime: at(10), lastContactTime: at(2), status: 'aktiv', readings: [], ...over,
})
const state = (t: Trupp) => tabState(t, deriveTruppLive(t, NOW, 10, 60))

// Atemschutz-Link redesign (owner pick R1, 30.10.2026): the tab says the state under the name
describe('tabState — the link tab line', () => {
  it('a crew at the door says «Bereit», never an empty «–:––»', () => {
    expect(state(trupp({ status: 'angemeldet', entryTime: '', lastContactTime: '' }))).toEqual({ word: az.phoneSectionReady, clock: '', tone: 'ready' })
  })
  it('a crew on Rückzug says so beside its contact clock', () => {
    expect(state(trupp({ status: 'rueckzug' }))).toEqual({ word: az.status.rueckzug, clock: '2:00', tone: 'rueckzug' })
  })
  it('a crew inside shows its contact clock alone, an overdue one too', () => {
    expect(state(trupp({}))).toEqual({ word: '', clock: '2:00', tone: 'clock' })
    expect(state(trupp({ lastContactTime: at(12) })).word).toBe('')
  })
})
