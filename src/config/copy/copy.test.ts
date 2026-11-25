// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { applyLocale, getCopy, getLocaleId, AVAILABLE_LOCALES } from './index'

// The i18n contract: every locale is a partial overlay deep-merged over German, so a missing
// key ANYWHERE falls back to the German string. These tests pin that fallback behaviour and
// the boot-time locale resolution (which the appConfig.copy getter and main.tsx depend on).
// Locale is a per-deployment setting: applyLocale() takes the deployment's identity.locale.

afterEach(() => applyLocale('de-CH')) // restore the default so other suites see German

describe('locale resolution', () => {
  it('defaults to German (de-CH) and its strings', async () => {
    await applyLocale('de-CH')
    expect(getLocaleId()).toBe('de-CH')
    expect(getCopy().atemschutz.title).toBe('Trupps')
    expect(getCopy().modes.map).toBe('Karte')
  })

  it('an unknown locale falls back to the German base', async () => {
    await applyLocale('it')
    await applyLocale('xx-YY')
    expect(document.documentElement.lang).toBe('de-CH')
    expect(getCopy().modes.map).toBe('Karte')
  })

  it('announces German when the requested catalogue cannot be loaded', async () => {
    vi.resetModules()
    vi.doMock('./it', () => { throw new Error('offline') })
    try {
      const fresh = await import('./index')
      await fresh.applyLocale('fr-CH')
      await fresh.applyLocale('it')
      expect(fresh.getCopy().modes.map).toBe('Karte')
      expect(document.documentElement.lang).toBe('de-CH')
    } finally {
      vi.doUnmock('./it')
      vi.resetModules()
    }
  })

  it('normalizes a regional tag to its base language (fr-CH → fr)', async () => {
    await applyLocale('fr-CH')
    expect(document.documentElement.lang).toBe('fr-CH')
    expect(getCopy().nav.dayMode).toBe('Jour')
  })
})

describe('English (full overlay)', () => {
  it('translates the general UI and the SCBA section', async () => {
    await applyLocale('en')
    expect(getCopy().modes.map).toBe('Map')
    expect(getCopy().atemschutz.title).toBe('Teams')
  })

  it('preserves functions across the overlay', async () => {
    await applyLocale('en')
    expect(getCopy().intake.objectPlans(1)).toBe('1 plan')
    expect(getCopy().intake.objectPlans(3)).toBe('3 plans')
  })

  it('keeps the UN/Stoff DATA keys German (they match preset field names)', async () => {
    await applyLocale('en')
    expect(getCopy().contextPanel.unField).toBe('UN-Nr.')
    expect(getCopy().contextPanel.stoffField).toBe('Stoff')
  })
})

describe('French / Italian (full translations)', () => {
  it('translate the chrome AND the SCBA section (Swiss fire-service terms)', async () => {
    await applyLocale('fr')
    expect(getCopy().nav.dayMode).toBe('Jour')
    expect(getCopy().atemschutz.title).toBe('Binômes') // now translated, not a fallback
    await applyLocale('it')
    expect(getCopy().nav.dayMode).toBe('Giorno')
    expect(getCopy().atemschutz.title).toBe('Squadre')
  })

  it('still fall back to German for the 4 structural data keys (not translated by design)', async () => {
    // unField/stoffField are data keys (match preset fields) — fr/it omit them, so German
    // shows through.
    for (const loc of ['fr', 'it']) {
      await applyLocale(loc)
      expect(getCopy().contextPanel.unField).toBe('UN-Nr.')
      expect(getCopy().contextPanel.stoffField).toBe('Stoff')
    }
  })
})

describe('admin picker registry', () => {
  it('offers exactly the four supported languages', async () => {
    expect(AVAILABLE_LOCALES.map((l) => l.id)).toEqual(['de-CH', 'en', 'fr', 'it'])
  })
})

// Label in name (WCAG 2.5.3; Sol review, PR #702): the Trupp card's chip SHOWS «⋯ Mehr» and was
// named «Weitere Aktionen» – «Mehr» said to voice control found nothing. Its name starts with its word.
describe('the Trupp card «⋯ Mehr» chip', () => {
  it('is named starting with its visible word, in every language', async () => {
    for (const { id } of AVAILABLE_LOCALES) {
      await applyLocale(id)
      const az = getCopy().atemschutz
      expect(az.cardMenu.startsWith(az.cardMenuWord), id).toBe(true)
    }
  })
})

// owner pick UX journeys B2·43 (25.11.2026): a time of day ends on «Uhr», a duration never – so
// «Notfall seit 00:15 Uhr» is never read as the Einsatz clock's «5:00». On the Trupps, every
// German `{time}` is a time of day (durations are `{dur}`, `{age}`, `{s}`).
describe('the Trupps say «Uhr» after a time of day', () => {
  it('every German {time} in the Atemschutz copy is followed by «Uhr»', async () => {
    await applyLocale('de-CH')
    const strings: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(getCopy().atemschutz)
    const bare = strings.filter((x) => /\{time\}(?! Uhr)/.test(x))
    expect(bare).toEqual([])
    expect(strings.filter((x) => x.includes('{time}')).length).toBeGreaterThan(5)
  })
})
