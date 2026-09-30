import { describe, it, expect } from 'vitest'
import { helpShows } from './helpDevice'
import { de } from '../config/copy/de'
import { en } from '../config/copy/en'
import { fr } from '../config/copy/fr'
import { it as itCopy } from '../config/copy/it'

const phone = { phone: true, finePointer: false }
const touchTablet = { phone: false, finePointer: false }
const desk = { phone: false, finePointer: true }

describe('helpShows', () => {
  it('shows untagged help everywhere', () => {
    for (const d of [phone, touchTablet, desk]) expect(helpShows(undefined, d)).toBe(true)
  })
  it('gives the phone its bars and the wide screen its rails', () => {
    expect(helpShows('phone', phone)).toBe(true)
    expect(helpShows('phone', desk)).toBe(false)
    expect(helpShows('wide', phone)).toBe(false)
    expect(helpShows('wide', touchTablet)).toBe(true)
  })
  it('shows the keyboard parts only where a fine pointer is — never on a phone', () => {
    expect(helpShows('keyboard', phone)).toBe(false)
    expect(helpShows('keyboard', { phone: true, finePointer: true })).toBe(false)
    expect(helpShows('keyboard', touchTablet)).toBe(false)
    expect(helpShows('keyboard', desk)).toBe(true)
  })
})

// ⚠️ A phone reading the help must not be told about a left rail, a right rail or dragging a rail
// edge — in any locale. Every locale carries its own sections array, so each is checked.
describe('the help a phone reads', () => {
  const RAIL = /linke Leiste|left rail|barre de gauche|barra sinistra|Rechte Werkzeugleiste|Right tool rail|Barre d’outils \(droite\)|Barra degli strumenti a destra|rechten Rand der Leiste|right edge of the rail|bord droit de la barre|bordo destro della barra/
  for (const [name, copy] of [['de', de], ['en', en], ['fr', fr], ['it', itCopy]] as const) {
    it(`${name}: no rail and no shortcut section`, () => {
      const sections = (copy as typeof de).help.sections.filter((s) => helpShows(s.only, phone))
      expect(sections.some((s) => s.id === 'tastatur')).toBe(false)
      for (const s of sections.filter((x) => x.id === 'ueberblick' || x.id === 'navigation')) {
        const text = s.blocks.filter((b) => b.kind !== 'intro' && helpShows(b.only, phone))
          .map((b) => (b.kind === 'list' ? b.items.join(' ') : 'text' in b ? b.text : '')).join(' ')
        expect(text).not.toMatch(RAIL)
      }
    })
  }
})
