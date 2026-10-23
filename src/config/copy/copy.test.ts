import { describe, it, expect, afterEach } from 'vitest'
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
    expect(getCopy().atemschutz.title).toBe('Atemschutzüberwachung')
    expect(getCopy().modes.map).toBe('Karte')
  })

  it('an unknown locale falls back to the German base', async () => {
    await applyLocale('xx-YY')
    expect(getCopy().modes.map).toBe('Karte')
  })

  it('normalizes a regional tag to its base language (fr-CH → fr)', async () => {
    await applyLocale('fr-CH')
    expect(getCopy().nav.dayMode).toBe('Jour')
  })
})

describe('English (full overlay)', () => {
  it('translates the general UI and the SCBA section', async () => {
    await applyLocale('en')
    expect(getCopy().modes.map).toBe('Map')
    expect(getCopy().atemschutz.title).toBe('SCBA monitoring')
  })

  it('preserves functions across the overlay', async () => {
    await applyLocale('en')
    expect(getCopy().intake.objectPlans(1)).toBe('1 plan')
    expect(getCopy().intake.objectPlans(3)).toBe('3 plans')
  })

  it('falls back to German for keys it deliberately omits (intake categories)', async () => {
    await applyLocale('en')
    // kategorien mirrors the backend German labels — untranslated by design
    expect(getCopy().intake.kategorien).toContain('Brandbekämpfung')
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
    expect(getCopy().atemschutz.title).toBe('Surveillance ARI') // now translated, not a fallback
    await applyLocale('it')
    expect(getCopy().nav.dayMode).toBe('Giorno')
    expect(getCopy().atemschutz.title).toBe('Sorveglianza autoprotezione')
  })

  it('still fall back to German for the 4 structural data keys (not translated by design)', async () => {
    // unField/stoffField are data keys (match preset fields); kategorien
    // mirrors the backend German keyword map — fr/it omit them, so German shows through.
    for (const loc of ['fr', 'it']) {
      await applyLocale(loc)
      expect(getCopy().contextPanel.unField).toBe('UN-Nr.')
      expect(getCopy().contextPanel.stoffField).toBe('Stoff')
      expect(getCopy().intake.kategorien).toContain('Brandbekämpfung')
    }
  })
})

describe('admin picker registry', () => {
  it('offers exactly the four supported languages', async () => {
    expect(AVAILABLE_LOCALES.map((l) => l.id)).toEqual(['de-CH', 'en', 'fr', 'it'])
  })
})
