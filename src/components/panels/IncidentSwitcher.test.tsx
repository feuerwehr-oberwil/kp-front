// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { IncidentSwitcher } from './IncidentSwitcher'
import { appConfig } from '../../config/appConfig'
import type { DiveraAlarm, IncidentMeta } from '../../lib/incidents'
import { einsatzHeadName } from '../../lib/format'

afterEach(cleanup)

function renderSwitcher(extra: Partial<Parameters<typeof IncidentSwitcher>[0]> = {}) {
  render(
    <IncidentSwitcher
      active={null}
      incidents={[]}
      isEditor
      syncStatus="synced"
      lastSyncedAt={null}
      user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
      onSwitch={() => {}}
      onDivera={() => {}}
      onHelp={() => {}}
      onSyncNow={() => {}}
      {...extra}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: appConfig.copy.incidentSwitcher.noIncident }))
}

/** The menu over an open Einsatz: the pill is named after it. */
function renderActive(extra: Partial<Parameters<typeof IncidentSwitcher>[0]> & { active: IncidentMeta }) {
  render(
    <IncidentSwitcher
      incidents={[]}
      isEditor
      syncStatus="synced"
      lastSyncedAt={null}
      user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
      onSwitch={() => {}}
      onDivera={() => {}}
      onHelp={() => {}}
      onSyncNow={() => {}}
      {...extra}
    />,
  )
  // the pill's name says what it shows, then the Einsatz («street, title, …»); a closed one's also
  // says so («…, Einsatz abgeschlossen»)
  fireEvent.click(screen.getByRole('button', { name: (n) => n.startsWith(einsatzHeadName(extra.active.title, extra.active.address)) }))
}

// Staging 03.10.2026: a device that always opens its running Einsatz never sees the launcher,
// so Objektbesuche has a second door in the menu every Einsatz carries.
describe('IncidentSwitcher · Objektbesuche', () => {
  it('offers Objektbesuche when the app hands a door, and opens it', () => {
    const open = vi.fn()
    renderSwitcher({ onObjectVisits: open })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.objectVisits.launcher }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('draws no row where the module is off or the session is a link', () => {
    renderSwitcher()
    expect(screen.queryByRole('button', { name: appConfig.copy.objectVisits.launcher })).toBeNull()
  })
})

// Owner 17.10.2026: the row to «Karte & Objekte» is «Einsatz verlassen» (it was «Karte & Objekte»
// in the App group). It is about THIS Einsatz, so it heads the doors out of it, and its sub line
// says the Einsatz keeps running — «verlassen» must never read as closing it.
describe('IncidentSwitcher · Einsatz verlassen', () => {
  afterEach(() => sessionStorage.clear())
  const active = {
    id: 'inc-1', title: 'Brand Musterhaus', address: 'Musterweg 1', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta
  const other = { ...active, id: 'inc-2', title: 'Ölspur Hauptstrasse', address: 'Hauptstrasse 2' } as IncidentMeta

  it('sits under the running rows, above «Alle Einsätze», and says the Einsatz runs on', () => {
    const leave = vi.fn()
    renderActive({ active, incidents: [active, other], onKarte: leave, onHistory: () => {}, onObjectVisits: () => {} })
    const row = screen.getByRole('button', { name: /Einsatz verlassen/ })
    expect(row.textContent).toContain('Läuft weiter – zur Karte')
    const running = screen.getByRole('button', { name: /Ölspur Hauptstrasse/ })
    const history = screen.getByRole('button', { name: appConfig.copy.incidentSwitcher.allIncidents })
    const visits = screen.getByRole('button', { name: appConfig.copy.objectVisits.launcher })
    expect(running.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // no longer in the «App» group
    expect(row.compareDocumentPosition(visits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Karte & Objekte/ })).toBeNull()
    fireEvent.click(row)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('names where the viewer picks up again', () => {
    sessionStorage.setItem('kp.karte.view', JSON.stringify({
      center: [7.57, 47.52], zoom: 17, bearing: 0, objectId: 'schloss', surface: { plan: 'p1' }, label: 'Schloss Musterdorf · Modul 1',
    }))
    renderActive({ active, incidents: [active], onKarte: () => {} })
    expect(screen.getByRole('button', { name: /Einsatz verlassen/ }).textContent).toContain('Läuft weiter – zurück zu Schloss Musterdorf · Modul 1')
  })

  it('draws no row for a link session (no door handed in), and no Einsätze group either', () => {
    renderActive({ active, incidents: [active], isEditor: false })
    expect(screen.queryByRole('button', { name: /Einsatz verlassen/ })).toBeNull()
    expect(screen.queryByRole('button', { name: appConfig.copy.incidentSwitcher.allIncidents })).toBeNull()
    expect(screen.queryByText(appConfig.copy.incidentSwitcher.noOpenIncidents)).toBeNull()
  })
})

// S8 (20.10.2026, owner: «all dropdowns, popovers … closable by Escape»). The menu stays
// non-modal; one Escape closes it and nothing behind it — the workspace's own Escape listens on
// window and must not also peel the map's next layer.
describe('IncidentSwitcher · Escape', () => {
  it('closes the menu, and the key does not travel on to the workspace', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      renderSwitcher()
      expect(document.querySelector('.ip-menu')).not.toBeNull()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(document.querySelector('.ip-menu')).toBeNull()
      expect(behind).not.toHaveBeenCalled()
      // closed: the next Escape is the workspace's again
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('leaves the key to a sheet opened from the menu', () => {
    renderSwitcher({ sheetOpen: true })
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)
    expect(behind).toHaveBeenCalledTimes(1)
  })
})

// Sweep #5 (27.10.2026, owner pick B): a closed Einsatz wears its lock in the pill's ✓ slot, and
// the card's «Gespeichert» becomes «Abgeschlossen <time>» – a pill that folds out the sentence and
// the exits only when tapped. The sentence is the session's own (RBAC audit 22.10.2026).
describe('IncidentSwitcher · closed Einsatz', () => {
  const C = appConfig.copy.archived
  const closed = {
    id: 'inc-1', title: 'Brandmeldeanlage', address: 'Gewerbestrasse 4', started_at: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'abgeschlossen', is_archived: true, is_exercise: false, closed_at: new Date(Date.now() - 1_800_000).toISOString(),
    last_closed_at: new Date(Date.now() - 600_000).toISOString(),
  } as unknown as IncidentMeta
  const pill = () => screen.getByRole('button', { name: new RegExp(`^${C.closedAt.replace('{t}', '')}`) })

  it('replaces «Gespeichert» with the close time and folds out the exits only on tap', async () => {
    const reopen = vi.fn(async () => 'ok' as const)
    const back = vi.fn()
    renderActive({ active: closed, onReactivate: reopen, onBackFromArchive: back })
    expect(screen.queryByText(appConfig.copy.incidentSwitcher.saved)).toBeNull()
    expect(screen.queryByText(C.reactivate)).toBeNull()
    fireEvent.click(pill())
    expect(screen.getByText(C.hint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: C.reactivate }))
    expect(reopen).toHaveBeenCalledTimes(1)
  })

  // button sweep SHEETS.11 (17.11.2026): the card's acts are glyph + word, the fold's exits too
  it('gives «Wieder öffnen» and «Zurück» their glyphs', () => {
    renderActive({ active: closed, onReactivate: vi.fn(async () => 'ok' as const), onBackFromArchive: vi.fn() })
    fireEvent.click(pill())
    const glyph = (name: string) => screen.getByRole('button', { name }).querySelector('use')?.getAttribute('href')
    expect(glyph(C.reactivate)).toBe('#pen')
    expect(glyph(C.back)).toBe('#chevron-left')
  })

  it('is the sentence alone in a link session', () => {
    renderActive({ active: closed, user: { display_name: 'Link', color: null, role: 'viewer' } })
    fireEvent.click(pill())
    expect(screen.getByText(C.hintViewOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.back })).toBeNull()
  })
})

// round 18.11.2026 #7 (owner: «Clean up header main title to just address»): the pill shows the
// street, else the title; the Einsatz's name stays in the card and in the button's name
describe('IncidentSwitcher · the pill says the address', () => {
  const active = {
    id: 'inc-1', title: 'Gymnasium', address: 'Allschwilerstrasse 100, 4104 Oberwil', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: true,
  } as unknown as IncidentMeta
  const title = () => document.querySelector('.ip-switch-btn .ip-switch-title')?.textContent
  it('shows the street alone, and names the Einsatz in the button and the card', () => {
    renderActive({ active })
    expect(title()).toBe('Allschwilerstrasse 100')
    expect(document.querySelector('.ip-switch-btn')?.getAttribute('aria-label')).toMatch(/^Allschwilerstrasse 100, Gymnasium, /)
    expect(document.querySelector('.ip-card-name')?.textContent).toBe('Gymnasium')
  })
  it('shows the title where there is no address', () => {
    renderActive({ active: { ...active, address: null } })
    expect(title()).toBe('Gymnasium')
    expect(document.querySelector('.ip-switch-btn')?.getAttribute('aria-label')).toMatch(/^Gymnasium, Übung/)
  })
})

// button sweep SHEETS.11 (17.11.2026): every act of the Einsatz card leads with its glyph, and
// «Teilen» wears the app's share glyph
describe('IncidentSwitcher · card acts', () => {
  const cp = appConfig.copy.incidentSwitcher
  const active = {
    id: 'inc-1', title: 'Zimmerbrand', address: 'Schlossgasse 10', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta
  it('Ändern · Teilen · Abschliessen, each with its glyph', () => {
    renderActive({ active, onEditMeta: vi.fn(), onShare: vi.fn(), onArchive: vi.fn() })
    const glyph = (name: string) => screen.getByRole('button', { name }).querySelector('use')?.getAttribute('href')
    expect(glyph(cp.editMeta)).toBe('#pen')
    expect(glyph(cp.share)).toBe('#share-ios')
    expect(glyph(cp.archive)).toBe('#archive')
  })
})

// M6 A (13.11.2026): a session that writes nothing here says «Nur ansehen» in the ✓'s slot, and
// its reason in the opened card. M11 B: another Einsatz's alarm puts a red dot on the shut pill.
describe('IncidentSwitcher · Nur ansehen and the foreign-alarm dot', () => {
  const cp = appConfig.copy.incidentSwitcher
  const active = {
    id: 'inc-1', title: 'Zimmerbrand', address: 'Schlossgasse 10', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta
  const pill = () => screen.getByRole('button', { name: (n) => n.startsWith(einsatzHeadName(active.title, active.address)) })
  const renderShut = (extra: Partial<Parameters<typeof IncidentSwitcher>[0]>) => render(
    <IncidentSwitcher active={active} incidents={[active]} isEditor={false} syncStatus="synced" lastSyncedAt={null}
      user={{ display_name: 'Betrachter', color: null, role: 'viewer' }} onSwitch={() => {}} onDivera={() => {}}
      onHelp={() => {}} onSyncNow={() => {}} {...extra} />,
  )

  it('wears «Nur ansehen» instead of the ✓, and the card names the reason', () => {
    renderShut({ viewOnly: 'viewer' })
    expect(pill().getAttribute('aria-label')).toContain(cp.viewOnly)
    expect(pill().querySelector('.ip-viewonly-chip')?.textContent).toBe(cp.viewOnly)
    expect(pill().querySelector('.ip-status')).toBeNull()
    fireEvent.click(pill())
    expect(screen.getByText(`${cp.viewOnly} · ${cp.viewOnlyWhy.viewer}`)).toBeTruthy()
  })

  // round 2b (owner's pick «Only show problems»): all saved → no mark; the ✓ is the card's
  it('shows no mark where the session writes and all is saved, and a sync warning outranks «Nur ansehen»', () => {
    renderShut({ viewOnly: null })
    expect(pill().querySelector('.ip-viewonly-chip')).toBeNull()
    expect(pill().querySelector('.ip-status')).toBeNull()
    expect(pill().dataset.sync).toBe('synced')
    cleanup()
    renderShut({ viewOnly: 'el', syncStatus: 'offline' })
    expect(pill().querySelector('.ip-viewonly-chip')).toBeNull()
    expect(pill().textContent).toContain(cp.offlineShort)
  })

  // round 2b: «Nicht synchronisiert» speaks up only once it outlasts a normal save; Offline wears
  // the struck-through cloud, pending the plain one
  it('marks pending only after the grace, and offline with the struck-through cloud', () => {
    vi.useFakeTimers()
    try {
      renderShut({ syncStatus: 'pending' })
      expect(pill().querySelector('.ip-status')).toBeNull()
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(pill().querySelector('.ip-status-pending use')?.getAttribute('href')).toBe('#wx-cloud')
      cleanup()
      renderShut({ syncStatus: 'offline' })
      expect(pill().querySelector('.ip-sync-word use')?.getAttribute('href')).toBe('#cloud-off')
    } finally { vi.useRealTimers() }
  })

  it('dots the shut pill while another running Einsatz has a Trupp at the alarm tier', () => {
    const other = { ...active, id: 'inc-2', title: 'BMA Gewerbestrasse', atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] } as unknown as IncidentMeta
    renderShut({ incidents: [active, other] })
    expect(pill().querySelector('.ip-foreign-dot')).not.toBeNull()
    expect(pill().getAttribute('aria-label')).toContain(cp.foreignAlarmDot)
    cleanup()
    // its own Trupps are the workspace's alarm, not that dot; once the list is quiet the other
    // real Einsatz still lights it, as a running Einsatz (C10)
    renderShut({ incidents: [{ ...active, atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] } as unknown as IncidentMeta, { ...other, atemschutz_due: [] }] })
    expect(pill().querySelector('.ip-foreign-dot')).not.toBeNull()
    expect(pill().getAttribute('aria-label')).toContain(cp.otherEinsatzDot)
  })

  // C10 (17.11.2026): another REAL Einsatz lights the dot too, a parallel Übung alone never
  it('dots the shut pill for another real Einsatz, not for an Übung', () => {
    const other = { ...active, id: 'inc-2', title: 'BMA Gewerbestrasse' } as IncidentMeta
    renderShut({ incidents: [active, { ...other, is_exercise: true }] })
    expect(pill().querySelector('.ip-foreign-dot')).toBeNull()
    expect(pill().getAttribute('aria-label')).not.toContain(cp.otherEinsatzDot)
    cleanup()
    renderShut({ incidents: [active, other] })
    expect(pill().querySelector('.ip-foreign-dot')).not.toBeNull()
    expect(pill().getAttribute('aria-label')).toContain(cp.otherEinsatzDot)
  })
})

// C8 / F15 (17.11.2026): a link guest's way in, and «Präsentieren» as the card's fourth act
describe('IncidentSwitcher · who is here', () => {
  const cp = appConfig.copy.incidentSwitcher
  const active = {
    id: 'inc-1', title: 'Zimmerbrand', address: null, started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta

  it('offers a link guest «Anmelden» in place of «Abmelden»', () => {
    const onLogin = vi.fn()
    renderActive({ active, viewOnly: 'link', onLogin, user: { display_name: 'Einsatz-Link', color: null, role: 'viewer' } })
    expect(screen.queryByRole('button', { name: new RegExp(cp.logout) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: cp.login }))
    expect(onLogin).toHaveBeenCalled()
  })

  it('puts «Präsentieren» between «Teilen» and «Abschliessen» when the door is handed in', () => {
    const onPresent = vi.fn()
    renderActive({ active, onPresent, onEditMeta: () => {}, onShare: () => {}, onArchive: () => {} })
    const acts = [...document.querySelectorAll('.ip-card-acts > .ip-card-act')].map((b) => b.textContent)
    expect(acts).toEqual([cp.editMetaShort, cp.shareShort, appConfig.copy.presentation.title, cp.archiveShort])
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.presentation.title }))
    expect(onPresent).toHaveBeenCalledTimes(1)
    // it STARTS the presentation (owner pick 29), so the menu steps out of its way
    expect(document.querySelector('.ip-card-acts')).toBeNull()
    cleanup()
    renderActive({ active })
    expect(screen.queryByRole('button', { name: appConfig.copy.presentation.title })).toBeNull()
  })

  // 17.11.2026 («Just list it»): an alarm nobody opened is listed in the Einsatz menu as on home
  it('lists an alarm waiting to be opened, and its row takes it', () => {
    const onTake = vi.fn()
    const alarm = { id: 'al-7', divera_id: 7, title: 'B2 Brand Wohnhaus', address: 'Testgasse 3', received_at: new Date().toISOString() } as DiveraAlarm
    renderActive({ active, alarms: { list: [alarm], taking: null, onTake } })
    fireEvent.click(screen.getByRole('button', { name: /B2 Brand Wohnhaus/ }))
    expect(onTake).toHaveBeenCalledWith(alarm)
  })

  // F7 (17.11.2026): a hidden «Alarm aktualisiert» comes back from the Einsatz menu, not from a strip
  it('lists a hidden «Alarm aktualisiert» as a quiet row whose «Zeigen» brings it back', () => {
    const onShow = vi.fn()
    renderActive({ active, folded: [{ key: 'alarm-update:inc-1', title: appConfig.copy.intake.alarmUpdate.title, onShow }] })
    const row = document.querySelector('.ip-alarm-folded') as HTMLElement
    expect(row.textContent).toContain(appConfig.copy.intake.alarmUpdate.title)
    fireEvent.click(within(row).getByRole('button'))
    expect(onShow).toHaveBeenCalled()
  })
})

// An Übung wears the hatched tag in the head, on the card and in the other running rows (M2,
// back on 14.11.2026 after the «Übung ·» prefix read as «almost invisible»), and the head's
// accessible name says «Übung» – the aria-label replaces the tag's own text.
describe('IncidentSwitcher · Übung', () => {
  const drill = {
    id: 'inc-1', title: 'Brand Musterhaus', address: null, started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: true,
  } as unknown as IncidentMeta
  const otherDrill = { ...drill, id: 'inc-2', title: 'Ölspur Hauptstrasse' } as IncidentMeta

  it('tags the head, the card and the row, and names the head an Übung', () => {
    render(
      <IncidentSwitcher active={drill} incidents={[drill, otherDrill]} isEditor syncStatus="synced" lastSyncedAt={null}
        user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
        onSwitch={() => {}} onDivera={() => {}} onHelp={() => {}} onSyncNow={() => {}} />,
    )
    const head = screen.getByRole('button', { name: `Brand Musterhaus, ${appConfig.copy.exerciseBadge}` })
    expect(head.querySelector('.ip-badge-exercise')?.textContent).toBe(appConfig.copy.exerciseBadge)
    fireEvent.click(head)
    expect(document.querySelector('.ip-card-title > .ip-badge-exercise')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Ölspur Hauptstrasse/ }).querySelector('.ip-badge-exercise')).not.toBeNull()
  })
})
