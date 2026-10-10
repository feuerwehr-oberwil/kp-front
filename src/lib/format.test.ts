import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyLocale } from '../config/copy'
import { compareText, formatLocale, localeDate, localeDateTime, dueClock, fillTemplate, fmtDuration, fmtFileSize, fmtMMSS, formatSymbolName, formatTime, initials, isNextDay, restoreUmlauts, roleLabel, stripUnprintable, telHref, unitLabel, streetPart } from './format'

describe('restoreUmlauts', () => {
  it('restores transliterated umlauts (lower + upper variants)', () => {
    expect(restoreUmlauts('Loeschgeraet')).toBe('Löschgerät')
    expect(restoreUmlauts('loeschen')).toBe('löschen')
    expect(restoreUmlauts('Sanitaet')).toBe('Sanität')
    expect(restoreUmlauts('Ueberflur')).toBe('Überflur')
    expect(restoreUmlauts('ueber')).toBe('über')
  })

  it('restores the whole-word "Ture" → "Türe" only on a word boundary', () => {
    expect(restoreUmlauts('Ture')).toBe('Türe')
    // \bTure\b should not touch a longer word that merely contains the letters
    expect(restoreUmlauts('Turestall')).toBe('Turestall')
  })

  it('leaves genuine (non-transliterated) German words alone', () => {
    expect(restoreUmlauts('Feuer')).toBe('Feuer')
    expect(restoreUmlauts('Wasser')).toBe('Wasser')
  })

  it('returns an empty string unchanged', () => {
    expect(restoreUmlauts('')).toBe('')
  })

  it('replaces every occurrence in a string (global)', () => {
    expect(restoreUmlauts('Ueber und ueber')).toBe('Über und über')
  })
})

describe('initials', () => {
  it('takes first + last initial for a multi-word name', () => {
    expect(initials('Hans Müller')).toBe('HM')
    expect(initials('Anna Maria Schmid')).toBe('AS')
  })

  it('takes the first two letters of a single word', () => {
    expect(initials('Posten')).toBe('PO')
  })

  it('folds umlauts so they map to ASCII initials', () => {
    // "Führungsunterstützung" → "FU", not "FÜ"
    expect(initials('Führungsunterstützung')).toBe('FU')
    expect(initials('Über Ärger')).toBe('UA')
    expect(initials('ßeta')).toBe('SS')
  })

  it('returns "?" for an empty / whitespace-only name', () => {
    expect(initials('')).toBe('?')
    expect(initials('   ')).toBe('?')
  })

  it('collapses repeated whitespace between words', () => {
    expect(initials('Hans   Peter')).toBe('HP')
  })

  it('uppercases the result', () => {
    expect(initials('hans müller')).toBe('HM')
  })
})

// The two duration formatters the whole app now shares. They disagree on purpose, and each
// disagreement is somebody's readout: the recorder pads BOTH halves so its width cannot jump,
// the player truncates so its counter never shows the end a second early, and a label rounds.
describe('fmtMMSS (the running recorder)', () => {
  it('pads both halves and does not cap the minutes', () => {
    expect(fmtMMSS(7)).toBe('00:07')
    expect(fmtMMSS(547)).toBe('09:07')
    expect(fmtMMSS(3607)).toBe('60:07')
  })
})

describe('fmtDuration', () => {
  it('formats m:ss and h:mm:ss for the player readout, truncating', () => {
    expect(fmtDuration(47)).toBe('0:47')
    expect(fmtDuration(754)).toBe('12:34')
    expect(fmtDuration(8103)).toBe('2:15:03')
    expect(fmtDuration(47.9)).toBe('0:47')
  })
  it('says «47s» and rounds in the compact label form', () => {
    expect(fmtDuration(47, { compact: true })).toBe('47s')
    expect(fmtDuration(0, { compact: true })).toBe('0s')
    expect(fmtDuration(754, { compact: true })).toBe('12:34')
    expect(fmtDuration(3675, { compact: true })).toBe('1:01:15')
    expect(fmtDuration(47.6, { compact: true })).toBe('48s')
  })
  it('never goes negative', () => {
    expect(fmtDuration(-5)).toBe('0:00')
  })
})

describe('roleLabel', () => {
  it('labels editor as "Bearbeiter"', () => {
    expect(roleLabel('editor')).toBe('Bearbeiter')
  })

  it('labels anything else (viewer) as "Betrachter"', () => {
    expect(roleLabel('viewer')).toBe('Betrachter')
    expect(roleLabel('whatever')).toBe('Betrachter')
    expect(roleLabel('')).toBe('Betrachter')
  })
})

describe('formatSymbolName', () => {
  it('uses the curated display-name override when present', () => {
    expect(formatSymbolName('VKF Feuer')).toBe('Feuer')
    expect(formatSymbolName('SI Ueberflurhydrant')).toBe('Überflurhydrant')
  })

  it('trims before looking up the override', () => {
    expect(formatSymbolName('  VKF Feuer  ')).toBe('Feuer')
  })

  it('strips a known name prefix and restores umlauts when no override exists', () => {
    // 'GB Loeschposten' has no override → strip 'GB ' prefix, restore umlaut
    expect(formatSymbolName('GB Loeschposten')).toBe('Löschposten')
  })

  it('strips a leading "<num> <num> " sequence', () => {
    expect(formatSymbolName('FW 12 34 Gefahr')).toBe('Gefahr')
  })

  it('leaves an unprefixed unknown name as-is (after umlaut restore)', () => {
    expect(formatSymbolName('Sanitaet')).toBe('Sanität')
  })
})

describe('formatTime', () => {
  it('formats hours:minutes by default (de-CH, 2-digit)', () => {
    const d = new Date(2026, 5, 20, 9, 5, 7)
    // de-CH uses a colon separator and 24h clock → "09:05"
    expect(formatTime(d)).toBe('09:05')
  })

  it('includes seconds when asked', () => {
    const d = new Date(2026, 5, 20, 9, 5, 7)
    expect(formatTime(d, true)).toBe('09:05:07')
  })

  it('pads single-digit hours', () => {
    const d = new Date(2026, 5, 20, 1, 2, 3)
    expect(formatTime(d)).toBe('01:02')
  })
})

/* B5, 08.10.2026: ~29 sites spelled 'de-CH' out (and lib/format itself read the static
 * `appConfig.locale`), so a French or Italian station got German dates and weekdays. They all go
 * through formatLocale now; for German the output must be byte-identical to what the literal said. */
describe('formatLocale and the locale helpers', () => {
  afterEach(async () => { await applyLocale() })
  const d = new Date(2026, 9, 7, 19, 5, 9) // Wed 07.10.2026, 19:05:09 local
  const shapes: (Intl.DateTimeFormatOptions | undefined)[] = [
    undefined,
    { day: '2-digit', month: '2-digit' },
    { day: '2-digit', month: '2-digit', year: 'numeric' },
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' },
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    { weekday: 'short', day: '2-digit', month: '2-digit' },
    { weekday: 'long', day: 'numeric', month: 'long' },
  ]

  it('is de-CH on a German station, and every helper says exactly what the literal said', () => {
    expect(formatLocale()).toBe('de-CH')
    for (const o of shapes) {
      expect(localeDate(d, o)).toBe(d.toLocaleDateString('de-CH', o))
      expect(localeDateTime(d, o)).toBe(d.toLocaleString('de-CH', o))
    }
    expect(formatTime(d)).toBe(d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }))
    expect(formatTime(d)).toBe('19:05')
    expect(formatTime(d, true)).toBe('19:05:09')
    expect(localeDate(d, { day: '2-digit', month: '2-digit' })).toBe('07.10.')
    expect(localeDateTime(d, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })).toBe('07.10., 19:05')
    // ISO strings and epoch ms are accepted where the call sites hold them
    expect(localeDateTime(d.toISOString())).toBe(d.toLocaleString('de-CH'))
    expect(localeDate(d.getTime())).toBe(d.toLocaleDateString('de-CH'))
    const names = ['Zürcher', 'Ammann', 'Äbi', 'Oberli', 'Öhler', 'brunner']
    expect([...names].sort(compareText)).toEqual([...names].sort((a, b) => a.localeCompare(b, 'de-CH')))
  })

  it('follows the deployment language, read as its Swiss form', async () => {
    await applyLocale('fr')
    expect(formatLocale()).toBe('fr-CH')
    expect(localeDate(d, { weekday: 'short' })).toBe(d.toLocaleDateString('fr-CH', { weekday: 'short' }))
    expect(localeDate(d, { weekday: 'long' })).toMatch(/mercredi/i)
    await applyLocale('it')
    expect(formatLocale()).toBe('it-CH')
    expect(localeDate(d, { weekday: 'long' })).toMatch(/mercoledì/i)
    // a bare «en» would be the US clock («07:05 PM»); a Swiss station reads 24 h
    await applyLocale('en')
    expect(formatLocale()).toBe('en-CH')
    expect(formatTime(d)).toBe('19:05')
    // a tag that names its region is taken as written
    await applyLocale('en-GB')
    expect(formatLocale()).toBe('en-GB')
    await applyLocale('de-CH')
    expect(formatLocale()).toBe('de-CH')
  })

  it('is the only way into a date, a time or a name sort: no literal locale left in src/', () => {
    const src = join(process.cwd(), 'src')
    const offenders: string[] = []
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || f.startsWith('config/copy')) continue
      readFileSync(join(src, f), 'utf8').split('\n').forEach((line, i) => {
        if (/(toLocale\w*String|localeCompare|DateTimeFormat)\([^)]*['"]de-CH['"]/.test(line)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('fillTemplate', () => {
  it('substitutes named placeholders', () => {
    expect(fillTemplate('Hallo {name}', { name: 'Welt' })).toBe('Hallo Welt')
  })

  it('stringifies numeric values', () => {
    expect(fillTemplate('{n} Fahrzeuge', { n: 5 })).toBe('5 Fahrzeuge')
  })

  it('replaces a missing key with an empty string', () => {
    expect(fillTemplate('a{missing}b', {})).toBe('ab')
  })

  it('replaces a placeholder whose value is 0 with "0", not empty', () => {
    expect(fillTemplate('{n}', { n: 0 })).toBe('0')
  })

  it('handles repeated placeholders and leaves literal braces-free text intact', () => {
    expect(fillTemplate('{x}-{x}', { x: 'q' })).toBe('q-q')
    expect(fillTemplate('no placeholders', {})).toBe('no placeholders')
  })
})

describe('dueClock (a Wiedervorlage that fell to tomorrow)', () => {
  it('prints the bare clock for a due time today', () => {
    const today = new Date()
    today.setHours(23, 30, 0, 0)
    expect(dueClock(today.toISOString())).toBe(formatTime(today))
  })

  it('says «morgen» once the due time is not today — the banner used to hide that', () => {
    const tomorrow = new Date(Date.now() + 26 * 3_600_000)
    expect(dueClock(tomorrow.toISOString())).toContain('morgen')
    expect(isNextDay(tomorrow.toISOString())).toBe(true)
  })
})

// The rapport is set in Helvetica, which has no glyph for any of these — an emoji that survives
// the input is a black box on the sheet that gets signed, and only there.
describe('stripUnprintable', () => {
  it('drops emoji and closes the gap they leave', () => {
    expect(stripUnprintable('Brand 🔥 im 2. OG')).toBe('Brand im 2. OG')
    expect(stripUnprintable('erledigt ✅')).toBe('erledigt ')
    expect(stripUnprintable('👨‍🚒 Trupp 1')).toBe(' Trupp 1')
  })

  it('leaves everything Helvetica can actually set', () => {
    expect(stripUnprintable('Öl · Hauptstrasse 4 – 2. OG, «Nord»')).toBe('Öl · Hauptstrasse 4 – 2. OG, «Nord»')
    expect(stripUnprintable('Müller/Wyss (TLF 1) 300 bar')).toBe('Müller/Wyss (TLF 1) 300 bar')
  })

  it('is a no-op on plain text, so it can sit on every keystroke', () => {
    const s = 'Wasserversorgung ab Hydrant Schlossgasse sichergestellt.'
    expect(stripUnprintable(s)).toBe(s)
  })

  // ⚠️ …except the two the journal writes ON PURPOSE. They sat inside the arrows block this rule
  // strips, so «EL → Sanität» lost its arrow again with the very next keystroke. Helvetica still
  // cannot set them — the PAPER gets «->», mapped where the payload is built (reportPdfDirect).
  it('keeps the two arrows the Funkprotokoll is written with, and no others', () => {
    expect(stripUnprintable('EL → Sanität: Patient stabil')).toBe('EL → Sanität: Patient stabil')
    expect(stripUnprintable('Polizei ← EL')).toBe('Polizei ← EL')
    expect(stripUnprintable('Trupp 2 ⇒ Keller')).toBe('Trupp 2 Keller')
    expect(stripUnprintable('nach ↑ oben')).toBe('nach oben')
  })
})

describe('telHref (the Kontaktperson dial link)', () => {
  it('dials the number as typed, Swiss formatting stripped', () => {
    expect(telHref('079 123 45 67')).toBe('tel:0791234567')
    expect(telHref('+41 61 401 12 34')).toBe('tel:+41614011234')
    expect(telHref('061/401 12 34')).toBe('tel:0614011234')
  })

  it('offers no link where there is nothing dialable', () => {
    expect(telHref('')).toBeUndefined()
    expect(telHref(undefined)).toBeUndefined()
    expect(telHref('-')).toBeUndefined()
    expect(telHref('kommt noch')).toBeUndefined()
  })
})

describe('fmtFileSize', () => {
  it('scales the unit and keeps operator-readable precision — one reading of a size app-wide', () => {
    expect(fmtFileSize(512)).toBe('512 B')
    expect(fmtFileSize(940 * 1024)).toBe('940 KB')
    expect(fmtFileSize(1.5 * 1024 ** 2)).toBe('1.5 MB')
    expect(fmtFileSize(120 * 1024 ** 2)).toBe('120 MB')
    expect(fmtFileSize(1.4 * 1024 ** 3)).toBe('1.4 GB')
    expect(fmtFileSize(20 * 1024 ** 3)).toBe('20 GB')
  })
  it('has a GB step — a 1.5 GB disk no longer reads «1536.0 MB»', () => {
    expect(fmtFileSize(1.5 * 1024 ** 3)).toBe('1.5 GB')
  })
  it('says «—» for a size the server did not report, or one that is nonsense', () => {
    expect(fmtFileSize(null)).toBe('—')
    expect(fmtFileSize(undefined)).toBe('—')
    expect(fmtFileSize(NaN)).toBe('—')
    expect(fmtFileSize(-1)).toBe('—')
  })
})

describe('unitLabel', () => {
  it('writes the litre as «L», so «40 l» never reads as «40 1»', () => {
    expect(unitLabel('l')).toBe('L')
    expect(unitLabel(' l ')).toBe('L')
    expect(unitLabel('L')).toBe('L')
  })
  it('leaves every other unit as the station spells it', () => {
    for (const u of ['Stk.', 'm', 'Sack', 'kg', 'ml', 'h', '']) expect(unitLabel(u)).toBe(u)
  })
})

describe('streetPart', () => {
  it('is everything before the first comma', () => {
    expect(streetPart('Schlossgasse 9, 9999 Musterdorf')).toBe('Schlossgasse 9')
    expect(streetPart('  Hauptstrasse 1 ,4104 Oberwil, CH')).toBe('Hauptstrasse 1')
    expect(streetPart('Bahnhof Oberwil')).toBe('Bahnhof Oberwil')
  })
  it('is empty for no address', () => {
    expect(streetPart(null)).toBe('')
    expect(streetPart(undefined)).toBe('')
    expect(streetPart(', Musterdorf')).toBe('')
  })
})
