import { describe, it, expect } from 'vitest'
import {
  REPORT_TABS, REPORT_TABS_FOLDED, initialReportTab, readReportTab, reportTabs, writeReportTab,
} from './reportTabs'

/** a sessionStorage stand-in — the app's own store is not available in the node environment */
function store() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    raw: map,
  }
}

describe('reportTabs — which tabs the Rapport has', () => {
  it('is the Rapport\'s own three on a tablet/desktop', () =>
    expect(reportTabs(false)).toEqual(['bericht', 'werwas', 'beilagen']))

  // The phone bar holds five tiles, so Anwesenheit and Material gave theirs up and moved in
  // here (18.09.2026).
  it('gains Anwesenheit and Material on a folded phone', () =>
    expect(reportTabs(true)).toEqual(['anwesenheit', 'mittel', 'bericht', 'werwas', 'beilagen']))

  // ⚠️ The WORKING order, not the printing order: those two are touched all through the Einsatz
  // while Bericht/Beilagen are written at the end of it — and they sit at the left edge, under
  // the thumb that just tapped the Rapport tile on the bar below.
  it('puts the two folded-in surfaces FIRST', () => {
    expect(REPORT_TABS_FOLDED.slice(0, 2)).toEqual(['anwesenheit', 'mittel'])
    expect(REPORT_TABS_FOLDED.slice(2)).toEqual(REPORT_TABS)
  })
})

describe('the last-used tab — per incident, per device', () => {
  it('reads back what was written', () => {
    const s = store()
    writeReportTab('i1', 'mittel', s)
    expect(readReportTab('i1', s)).toBe('mittel')
  })

  // The stamp is part of the record: a tab chosen at last week's Übung must not decide where
  // tonight's alarm opens.
  it('is null for a different Einsatz', () => {
    const s = store()
    writeReportTab('i1', 'mittel', s)
    expect(readReportTab('i2', s)).toBeNull()
  })

  it('is null with nothing written at all', () => expect(readReportTab('i1', store())).toBeNull())

  // a box written by an older build, or hand-edited, must not select a tab that does not exist
  it('refuses a value that is not a tab', () => {
    const s = store()
    s.setItem('kp-front-rapport-tab', JSON.stringify({ incidentId: 'i1', tab: 'zeiten' }))
    expect(readReportTab('i1', s)).toBeNull()
  })

  it('survives a box that is not JSON at all', () => {
    const s = store()
    s.setItem('kp-front-rapport-tab', 'not json')
    expect(readReportTab('i1', s)).toBeNull()
  })
})

describe('initialReportTab — which tab opens', () => {
  const opts = { incidentId: 'i1', folded: true, presentCount: 0 }

  // ⚠️ Nobody marked present yet = the crew is arriving and the rapport has nothing in it to
  // read, so the arrival minutes are the only thing anybody opens it for.
  it('opens on Anwesenheit on a folded phone while nobody is present', () =>
    expect(initialReportTab({ ...opts, store: store() })).toBe('anwesenheit'))

  it('opens on Bericht once somebody is on scene', () =>
    expect(initialReportTab({ ...opts, presentCount: 3, store: store() })).toBe('bericht'))

  // the default rule is a PHONE rule: on a tablet the Anwesenheit is its own surface, one tile
  // away, and the Rapport opens where it always did
  it('opens on Bericht on a tablet, present or not', () => {
    expect(initialReportTab({ ...opts, folded: false, store: store() })).toBe('bericht')
    expect(initialReportTab({ ...opts, folded: false, presentCount: 5, store: store() })).toBe('bericht')
  })

  // The Appell is «Rapport → correct a name → away → back», several times over — a return that
  // landed on the default would cost a tap on every round trip.
  it('prefers the last tab used for this Einsatz', () => {
    const s = store()
    writeReportTab('i1', 'beilagen', s)
    expect(initialReportTab({ ...opts, presentCount: 3, store: s })).toBe('beilagen')
  })

  it('…even when that tab is one of the folded-in surfaces', () => {
    const s = store()
    writeReportTab('i1', 'mittel', s)
    expect(initialReportTab({ ...opts, presentCount: 3, store: s })).toBe('mittel')
  })

  // written on a phone, read after the window was widened: «Anwesenheit» is not in the tablet's
  // strip at all, and selecting it would have shown an empty page
  it('falls back to the default for a tab this device cannot show', () => {
    const s = store()
    writeReportTab('i1', 'anwesenheit', s)
    expect(initialReportTab({ ...opts, folded: false, store: s })).toBe('bericht')
  })

  it('does not take another Einsatz\'s tab', () => {
    const s = store()
    writeReportTab('i-other', 'beilagen', s)
    expect(initialReportTab({ ...opts, presentCount: 3, store: s })).toBe('bericht')
  })
})
