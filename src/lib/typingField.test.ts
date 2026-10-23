import { describe, expect, it } from 'vitest'
import { defuseAutofill, typingFieldProps } from './typingField'

// review round 3
describe('typingFieldProps — no «AutoFill Contact» over a search or a UN number', () => {
  it('names the field a search and switches every assistant off', () => {
    const p = typingFieldProps('number', 'karte-un')
    expect(p.name).toBe('search-karte-un')
    expect(p).toMatchObject({ autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'search', inputMode: 'numeric' })
    expect(typingFieldProps('search', 'karte').inputMode).toBe('search')
  })
})

describe('defuseAutofill', () => {
  it('reads the same once the joiners are gone, but no word stays whole for Safari\'s keyword guess', () => {
    const out = defuseAutofill('Adresse oder Objekt')
    expect(out.replace(/⁠/g, '')).toBe('Adresse oder Objekt')
    expect(out).not.toMatch(/Adresse|Nr/)
    expect(defuseAutofill('UN-Nr.')).not.toContain('Nr')
  })
  it('is idempotent and leaves one-letter words and digits alone', () => {
    expect(defuseAutofill(defuseAutofill('UN-Nr.'))).toBe(defuseAutofill('UN-Nr.'))
    expect(defuseAutofill('z. B. 1203')).toBe('z. B. 1203')
  })
})
