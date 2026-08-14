/**
 * Where a long symbol label may be broken across lines in the palette.
 *
 * ⚠️ Automatic hyphenation (`hyphens: auto`) is what this replaces. The browser's German
 * dictionary breaks by SYLLABLE — «Kontrollpos-ten», «Verwundeten-nest» — and a tactical symbol
 * read at arm's length is recognised by its first component («Wasser…», «Brand…»). Breaking
 * inside that component is exactly the break that costs a beat. So: `hyphens: manual` in the
 * CSS, and the seams are named here, at the COMPOUND boundaries.
 *
 * A display label, not the data: the soft hyphens are inserted at render time (Palette) and
 * never enter `symbolNames`, because that string is also what search matches on, what the
 * context panel titles and what the server prints. An invisible U+00AD in any of those is a
 * bug that only shows up in a Rapport.
 *
 * Keyed on the German labels (config/copy/de.ts · symbolNames) — they are the compounds. A
 * locale whose label is not in the table (or a station's own override) simply comes back
 * unchanged, which is the behaviour without this table at all.
 */
const SEAMS: Record<string, string> = {
  Gefahrstoffe: 'Gefahr­stoffe',
  Gefahrentafel: 'Gefahren­tafel',
  Elektroanlage: 'Elektro­anlage',
  Patientensammelstelle: 'Patienten­sammel­stelle',
  Sanitätshilfsstelle: 'Sanitäts­hilfs­stelle',
  Totensammelstelle: 'Toten­sammel­stelle',
  Verwundetennest: 'Verwundeten­nest',
  Einsatzleiter: 'Einsatz­leiter',
  Kontrollposten: 'Kontroll­posten',
  Informationszentrum: 'Informations­zentrum',
  Materialdepot: 'Material­depot',
  Verkehrssperre: 'Verkehrs­sperre',
  Wassersauger: 'Wasser­sauger',
  Helilandeplatz: 'Heli­lande­platz',
  Kleinlöschgerät: 'Klein­lösch­gerät',
  Sprungretter: 'Sprung­retter',
  Überflurhydrant: 'Überflur­hydrant',
  Unterflurhydrant: 'Unterflur­hydrant',
  Innenhydrant: 'Innen­hydrant',
  Wasserlöschposten: 'Wasser­lösch­posten',
  Wasserbezugsort: 'Wasser­bezugs­ort',
  Wasserdruckversorgung: 'Wasser­druck­versorgung',
  Elektrotableau: 'Elektro­tableau',
  Sprinklerzentrale: 'Sprinkler­zentrale',
  Brandmeldezentrale: 'Brand­melde­zentrale',
  Fernsignaltableau: 'Fern­signal­tableau',
  Schlüsseldepot: 'Schlüssel­depot',
  Windrichtung: 'Wind­richtung',
}

/** The label with soft hyphens at its compound seams — for display in a narrow cell only. */
export function softHyphenate(label: string): string {
  return SEAMS[label] ?? label
}
