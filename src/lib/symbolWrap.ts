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
 *
 * ⚠️ The Lage map's caption is NOT a symbol name — it is a FIELD VALUE («CO₂», «Salpetersäure,
 * rauchend», «1200 l/min ab Weiher»). Looking a whole caption up in this table is almost a
 * no-op, which is why `softHyphenateText` walks it word by word and why the table now carries
 * the substance/value compounds an operator actually types, below the symbol names.
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
  // ── caption compounds: values, not symbol names ──
  // What an operator types into a symbol's detail field, where the same rule applies: a
  // Gefahrstoff is recognised by its first component («Salpeter…», «Natron…»). Curated, not
  // generated — a wrong seam is worse than no seam, so a word that is not here stays whole.
  Salpetersäure: 'Salpeter­säure',
  Schwefelsäure: 'Schwefel­säure',
  Salzsäure: 'Salz­säure',
  Natronlauge: 'Natron­lauge',
  Ammoniaklösung: 'Ammoniak­lösung',
  Wasserstoffperoxid: 'Wasserstoff­peroxid',
  Löschwasserrückhaltung: 'Lösch­wasser­rück­haltung',
  Überdruckbelüftung: 'Über­druck­belüftung',
  Rauchschutzvorhang: 'Rauch­schutz­vorhang',
  Trinkwassernetz: 'Trink­wasser­netz',
  Löschwasserbecken: 'Lösch­wasser­becken',
  Schaummittel: 'Schaum­mittel',
  Atemschutzsammelstelle: 'Atemschutz­sammel­stelle',
}

/** The label with soft hyphens at its compound seams — for display in a narrow cell only. */
export function softHyphenate(label: string): string {
  return SEAMS[label] ?? label
}

/**
 * The same seams for FREE TEXT — a map caption, which is a field value and almost never one
 * whole table key («Salpetersäure, rauchend», «1200 l/min ab Weiher»). Each word is looked up
 * on its own, with trailing punctuation left attached, so the parts that ARE compounds get
 * their seams and everything else comes back untouched.
 */
export function softHyphenateText(text: string): string {
  if (!text) return text
  // split on whitespace RUNS and keep them, so a multi-line caption ('all' mode) survives intact
  return text.split(/(\s+)/).map((token) => {
    if (!token || /^\s+$/.test(token)) return token
    const m = /^([^.,;:()]+)(.*)$/.exec(token)
    if (!m) return token
    return (SEAMS[m[1]] ?? m[1]) + m[2]
  }).join('')
}
