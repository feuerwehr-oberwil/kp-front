import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyLocale } from '../config/copy'
import { formatTime, localeDate, localeDateTime, zoneIfTwice } from './format'
import { formatDateTime } from './report'
import { otherDay, rowTime } from './verlauf'
import type { TimelineEvent } from '../types'

// The Verlauf and the Rapport format several stamps per row; a `toLocale*String(locale, opts)`
// call builds a new ICU formatter each time (sweep 26.11.2026: 55 % of «open Verlauf» on a slow
// tablet). Both kinds of construction are counted here: the Intl constructor and the Date methods.
const tz = process.env.TZ
afterAll(() => { process.env.TZ = tz })
afterEach(async () => { await applyLocale() })

function countFormatters<T>(run: () => T): number {
  const Real = Intl.DateTimeFormat
  const proto = Date.prototype
  const real = { d: proto.toLocaleDateString, t: proto.toLocaleTimeString, s: proto.toLocaleString }
  let n = 0
  Intl.DateTimeFormat = new Proxy(Real, { construct: (t, a) => { n++; return Reflect.construct(t, a) } })
  proto.toLocaleDateString = function (this: Date, l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { n++; return real.d.call(this, l, o) }
  proto.toLocaleTimeString = function (this: Date, l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { n++; return real.t.call(this, l, o) }
  proto.toLocaleString = function (this: Date, l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { n++; return real.s.call(this, l, o) }
  try { run() } finally {
    Intl.DateTimeFormat = Real
    Object.assign(proto, { toLocaleDateString: real.d, toLocaleTimeString: real.t, toLocaleString: real.s })
  }
  return n
}

const stamps = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2026, 9, 24, 20, 0) + i * 7 * 60_000 + i * 1_013))

describe('date and time formatters are built once per option set', () => {
  it('300 Verlauf/Rapport stamps build a handful of formatters, not one per call', () => {
    process.env.TZ = 'Europe/Zurich'
    const now = new Date(Date.UTC(2026, 9, 26, 12))
    const n = countFormatters(() => {
      for (const d of stamps) {
        formatTime(d)
        formatTime(d, true)
        formatDateTime(d.toISOString())
        rowTime({ at: d.toISOString(), t: '' } as TimelineEvent)
        otherDay(d, now)
        zoneIfTwice(d)
        localeDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' })
        localeDateTime(d, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      }
    })
    // one per option set: HH:MM, HH:MM:SS, the date, day.month, the row date+time – plus the zone
    // name, built fresh for each stamp in the two hours the autumn change shows 02:xx twice
    const twice = stamps.filter((d) => d >= new Date('2026-10-25T00:00:00Z') && d < new Date('2026-10-25T02:00:00Z')).length
    expect(twice).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(5 + twice)
  })

  it('says exactly what toLocale*String said, in every locale the cache is keyed by', async () => {
    for (const lang of ['de-CH', 'fr', 'en'] as const) {
      await applyLocale(lang)
      const loc = lang.includes('-') ? lang : `${lang}-CH`
      for (const d of stamps.slice(0, 40)) {
        expect(formatTime(d)).toBe(d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }))
        expect(formatTime(d, true)).toBe(d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
        expect(formatDateTime(d.toISOString())).toBe(
          `${d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}`)
        expect(otherDay(d, new Date(2030, 0, 1))).toBe(d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit' }))
        expect(localeDateTime(d)).toBe(d.toLocaleString(loc))
        expect(localeDate(d)).toBe(d.toLocaleDateString(loc))
      }
    }
    expect(formatDateTime('2026-08-16T13:35:00Z')).toMatch(/^\d\d\.\d\d\.2026 \d\d:\d\d$/)
  })

  it('follows a change of the local time zone', () => {
    const d = new Date('2026-07-01T12:00:00Z')
    process.env.TZ = 'UTC'
    expect(formatTime(d)).toBe('12:00')
    process.env.TZ = 'Europe/Zurich'
    expect(formatTime(d)).toBe('14:00')
    expect(formatDateTime('2026-07-01T23:30:00Z')).toBe('02.07.2026 01:30')
    // zones with the same offsets in January and July, but not on every day
    const jan = new Date('2026-01-10T23:30:00Z')
    process.env.TZ = 'Europe/Helsinki'
    expect(formatTime(jan)).toBe('01:30')
    process.env.TZ = 'Europe/Minsk'
    expect(formatTime(jan)).toBe('02:30')
    const mar = new Date('2026-03-28T23:30:00Z')
    process.env.TZ = 'Europe/Helsinki'
    expect(formatTime(mar)).toBe('01:30')
    process.env.TZ = 'Asia/Beirut'
    expect(formatTime(mar)).toBe(mar.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }))
  })

  it('keeps what an invalid date gave', () => {
    expect(formatTime(new Date('nope'))).toBe('Invalid Date')
    expect(formatDateTime('nope')).toBe('nope')
    expect(localeDate('nope')).toBe('Invalid Date')
  })

  it('names the zone of a wall time the autumn change shows twice', () => {
    process.env.TZ = 'Europe/Zurich'
    expect(zoneIfTwice(new Date('2026-10-25T00:15:00Z'))).toBe(' MESZ') // 02:15, first time
    expect(zoneIfTwice(new Date('2026-10-25T01:15:00Z'))).toBe(' MEZ') // 02:15, second time
    expect(zoneIfTwice(new Date('2026-10-25T03:15:00Z'))).toBe('')
  })
})
