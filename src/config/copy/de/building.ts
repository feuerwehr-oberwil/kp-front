// German copy · the Gebäude card and floors.
// One slice of the canonical `de` catalogue, assembled in ../de.ts — read the rules at the
// top of that file before adding or renaming a key here.

export const buildingCopy = {
  // The Gebäude card under the Einsatz card in the incident menu (BuildingCard, KP Front F5):
  // federal register hints (GWR, BFE) + the Einsatzobjekt's own Modul-1 notes. «Register-
  // Hinweis», never «Fakt»: the register can be years behind the building.
  building: {
    title: 'Gebäude',
    hint: 'Register-Hinweis',
    hintTitle: 'Aus den Bundesregistern (GWR, BFE) – kann veraltet oder unvollständig sein. Vor Ort prüfen.',
    floors: '{n} Geschosse',
    floorsOne: '1 Geschoss',
    flats: '{n} Wohnungen',
    flatsOne: '1 Wohnung',
    year: 'Baujahr {y}',
    period: 'Bauperiode {p}',
    shelter: 'Schutzraum',
    heating: 'Heizung {e}',
    hotWater: 'Warmwasser {e}',
    pv: 'PV {kw}',
    pvBare: 'PV',
    pvTitle: 'Photovoltaik im BFE-Register{since} – kann fehlen, auch wenn eine Anlage da ist',
    pvSince: ', in Betrieb seit {d}',
    kw: '{n} kW',
    energy: {
      gas: 'Gas',
      oil: 'Heizöl',
      wood: 'Holz',
      district: 'Fernwärme',
      air: 'Wärmepumpe (Luft)',
      geothermal: 'Wärmepumpe (Erdwärme)',
      water: 'Wärmepumpe (Wasser)',
      electricity: 'Elektro',
      solar: 'Solar',
      waste_heat: 'Abwärme',
      other: 'andere',
    },
    status: {
      planned: 'projektiert',
      approved: 'bewilligt',
      under_construction: 'im Bau',
      unusable: 'nicht nutzbar',
      demolished: 'abgebrochen',
      not_built: 'nicht realisiert',
    },
    // the one line of sources under the chips — every fact names where it came from and when
    srcGwr: 'GWR {a} · Stand {d}',
    srcGwrNoAddr: 'GWR Stand {d}',
    srcHeating: 'Heizung erfasst {d}',
    srcPv: 'BFE abgefragt {d}',
    srcCached: 'gespeichert {d}',
    measures: 'Sofortmassnahmen',
    remarks: 'Bemerkungen',
    objectSource: '{name} · {src}',
    objectNear: '{name} · in der Nähe ({m} m)',
    objectNearNoDist: '{name} · in der Nähe',
    visit: 'Letzter Objektbesuch {d}',
    visitFindings: 'Letzter Objektbesuch {d} · {n} Mängel',
    visitFindingsOne: 'Letzter Objektbesuch {d} · 1 Mangel',
    // the chip on the Karte / in the plan's chip row that opens the card (BuildingFloat)
    // not «Gebäude» alone: that word + the storey glyph is the rail's Gebäude tile, a surface
    chipTitle: 'Gebäude-Info',
    chipLabel: 'Gebäude-Steckbrief öffnen',
    chipLabelHazards: 'Gebäude: {h} – Steckbrief öffnen',
    measuresShort: 'Sofortmassn.',
  },
} as const
