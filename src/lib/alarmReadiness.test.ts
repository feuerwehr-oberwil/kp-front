// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHECK_DAYS, LATER_DAYS, SESSION_WARN_DAYS, SUBSCRIPTION_STALE_DAYS,
  alarmReady, nudgeDue, patchReadinessStore, readReadinessStore, readinessRows, readinessSummary, type ReadinessFacts, type ReadinessStore,
} from './alarmReadiness'

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 23, 3, 0)
const green: ReadinessFacts = { now: NOW, standalone: true, platform: 'ios', permission: 'granted', subscribedAt: NOW - 10 * DAY, sessionUntil: NOW + 80 * DAY }
const byKey = (f: ReadinessFacts) => Object.fromEntries(readinessRows(f).map((r) => [r.key, r]))

describe('the four rows', () => {
  it('a device that would wake is green on every row', () => {
    const rows = readinessRows(green)
    expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(alarmReady(rows)).toBe(true)
  })

  it('an iOS browser tab is red on «installiert» – push exists only in the installed app; Android is a hint', () => {
    expect(byKey({ ...green, standalone: false }).installed).toMatchObject({ state: 'red', fix: 'install', sub: 'browserIos' })
    expect(byKey({ ...green, standalone: false, platform: 'android' }).installed).toMatchObject({ state: 'warn', fix: 'install', sub: 'browser' })
  })

  it('permission: not yet asked → «Erlauben», denied → the system, no Notification global on iOS → install first', () => {
    expect(byKey({ ...green, permission: 'default' }).permission).toMatchObject({ state: 'red', fix: 'allow' })
    expect(byKey({ ...green, permission: 'denied' }).permission).toMatchObject({ state: 'red', fix: 'system' })
    expect(byKey({ ...green, standalone: false, permission: 'unsupported' }).permission).toMatchObject({ state: 'red', fix: 'install', sub: 'afterInstall' })
  })

  it('the registration is red when absent or past 150 days, and borrows «Erlauben» while the permission is missing', () => {
    expect(byKey({ ...green, subscribedAt: null }).subscription).toMatchObject({ state: 'red', fix: 'renew', sub: 'none' })
    expect(byKey({ ...green, subscribedAt: null, permission: 'default' }).subscription).toMatchObject({ state: 'red', fix: 'allow' })
    expect(byKey({ ...green, subscribedAt: NOW - (SUBSCRIPTION_STALE_DAYS + 1) * DAY }).subscription).toMatchObject({ state: 'red', fix: 'renew', sub: 'stale' })
    expect(byKey({ ...green, subscribedAt: NOW - (SUBSCRIPTION_STALE_DAYS - 1) * DAY }).subscription.state).toBe('ok')
  })

  it('the login: expired is red, under two weeks a warning, unknown a warning – never a button', () => {
    expect(byKey({ ...green, sessionUntil: NOW - 1 }).session).toMatchObject({ state: 'red', fix: null, sub: 'gone' })
    expect(byKey({ ...green, sessionUntil: NOW + (SESSION_WARN_DAYS - 1) * DAY }).session).toMatchObject({ state: 'warn', sub: 'soon' })
    expect(byKey({ ...green, sessionUntil: null }).session).toMatchObject({ state: 'warn', sub: 'unknown' })
  })
})

// sweep 28.10.2026, 17A: the rows fold into one line that names the worst state and its count
describe('the one line', () => {
  it('green with nothing to count, amber counts the hints, red counts what is missing and wins', () => {
    expect(readinessSummary(readinessRows(green))).toEqual({ state: 'ok', count: 0 })
    expect(readinessSummary(readinessRows({ ...green, standalone: false, platform: 'android' }))).toEqual({ state: 'warn', count: 1 })
    // an iOS tab: not installed AND no Notification global — two red rows, the session hint does not count
    expect(readinessSummary(readinessRows({ ...green, standalone: false, permission: 'unsupported', sessionUntil: null }))).toEqual({ state: 'red', count: 2 })
  })
})

describe('the nudge card', () => {
  const store = (p: Partial<ReadinessStore> = {}): ReadinessStore => ({ subscribedAt: null, lastTest: null, lastCheck: NOW - DAY, optedOut: false, laterUntil: null, ...p })
  const ctx = (p: Partial<Parameters<typeof nudgeDue>[1]> = {}) => ({ now: NOW, inIncident: false, linkSession: false, pushUnavailable: false, store: store(), ...p })
  const red = readinessRows({ ...green, permission: 'default' })
  const ok = readinessRows(green)

  it('shows for a red row, and for a device nobody checked in 90 days', () => {
    expect(nudgeDue(red, ctx())).toBe(true)
    expect(nudgeDue(ok, ctx())).toBe(false)
    expect(nudgeDue(ok, ctx({ store: store({ lastCheck: null }) }))).toBe(true)
    expect(nudgeDue(ok, ctx({ store: store({ lastCheck: NOW - (CHECK_DAYS + 1) * DAY }) }))).toBe(true)
  })

  it('never inside an Einsatz, for a link session, without push on the deployment, after an opt-out, or inside «Später»', () => {
    expect(nudgeDue(red, ctx({ inIncident: true }))).toBe(false)
    expect(nudgeDue(red, ctx({ linkSession: true }))).toBe(false)
    expect(nudgeDue(red, ctx({ pushUnavailable: true }))).toBe(false)
    expect(nudgeDue(red, ctx({ store: store({ optedOut: true }) }))).toBe(false)
    expect(nudgeDue(red, ctx({ store: store({ laterUntil: NOW + LATER_DAYS * DAY }) }))).toBe(false)
    expect(nudgeDue(red, ctx({ store: store({ laterUntil: NOW - 1 }) }))).toBe(true)
  })
})

describe('the device record', () => {
  beforeEach(() => localStorage.clear())

  it('reads empty, patches, and survives a corrupt value', () => {
    expect(readReadinessStore()).toEqual({ subscribedAt: null, lastTest: null, lastCheck: null, optedOut: false, laterUntil: null })
    patchReadinessStore({ subscribedAt: NOW, optedOut: true })
    expect(readReadinessStore()).toMatchObject({ subscribedAt: NOW, optedOut: true, lastTest: null })
    localStorage.setItem('kp-alarm-readiness', '{not json')
    expect(readReadinessStore().optedOut).toBe(false)
  })
})
