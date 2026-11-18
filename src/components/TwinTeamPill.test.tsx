// @vitest-environment jsdom
/**
 * The selected Trupp pill and its join sheet — the ONE copy every surface renders. What is pinned
 * here is what the sheet offers and what it calls; the surfaces' own wiring is covered by the
 * Whiteboard / MapMarkers tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'
import type { Trupp } from '../types'
import { TwinTeamPill } from './TwinTeamPill'

afterEach(() => {
  cleanup()
  savePrefs({ ...loadPrefs(), railLabels: undefined, railLabelsChosen: undefined })
})

const A = appConfig.copy.atemschutz
/** a picked row's text: its word, then the screen reader's «gewählt» (MenuPick) */
const picked = (w: string) => w + appConfig.copy.drawingEditor.menuPicked
const TRUPPS: Trupp[] = [
  { id: 't1', no: 2, name: 'Meier Anna', status: 'aktiv', members: [], readings: [] } as unknown as Trupp,
]

describe('the join sheet of a loose Trupp marker', () => {
  it('offers «Neuer Trupp» last, and it asks the surface to register one for THIS marker', () => {
    const newTrupp = vi.fn()
    const pick = vi.fn()
    render(<TwinTeamPill name="Trupp 3" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ pick, newTrupp, clearTrail: () => {}, remove: () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent)
    // no «Kein Trupp» on a marker that hangs on no hose (15.09.): the entry exists only on a hose
    expect(items).toEqual(['Meier Anna', appConfig.copy.whiteboard.newTeam])
    fireEvent.click(screen.getByRole('menuitem', { name: appConfig.copy.whiteboard.newTeam }))
    expect(newTrupp).toHaveBeenCalledTimes(1)
    expect(pick).not.toHaveBeenCalled()
  })

  it('has no «Neuer Trupp» row where the surface does not offer it', () => {
    render(<TwinTeamPill name="Trupp 3" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ pick: () => {}, clearTrail: () => {}, remove: () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    expect(screen.queryByRole('menuitem', { name: appConfig.copy.whiteboard.newTeam })).toBeNull()
  })
})

describe('the selected pill of a bound Trupp', () => {
  // the «#N» badge lives on the Atemschutz card only (docs/trupp-naming.md §2, 14.09.)
  it('shows the leader name alone — no «#N» badge', () => {
    const { container } = render(<TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(container.querySelector('.trupp-no')).toBeNull()
    expect(container.textContent).not.toContain('#2')
  })
})

// 18.09.2026
describe('the action bar and the trail', () => {
  const W = appConfig.copy.whiteboard
  // the delete rows are the last rows of «Mehr» (rare-user round 2, M12, 17.11.2026)
  const openTrash = () => fireEvent.click(screen.getByRole('button', { name: W.barMore }))
  const rowNames = () => screen.getAllByRole('menuitem').map((el) => el.textContent)

  // ONE trash. The bar carried a second, footprint-glyphed «Spur löschen» button for a day, and
  // the building outline did not read as a delete — so the delete asks WHICH of the two goes.
  it('asks which of the two goes, and each row does exactly that', () => {
    const remove = vi.fn()
    const clearTrail = vi.fn()
    const removeWithTrail = vi.fn()
    render(<TwinTeamPill name="Müller" color="#c00" raus={false} trailCount={4} trailShown trupps={TRUPPS}
      acts={{ clearTrail, remove, removeWithTrail }} />)
    openTrash()
    expect(rowNames()).toEqual([W.removeMarker, W.clearTrail, W.removeMarkerTrail])
    // …and the two that destroy the record are danger rows
    expect(screen.getByRole('menuitem', { name: W.removeMarker }).className).not.toContain('ui-menu-danger')
    for (const name of [W.clearTrail, W.removeMarkerTrail]) {
      expect(screen.getByRole('menuitem', { name }).className).toContain('ui-menu-danger')
    }

    fireEvent.click(screen.getByRole('menuitem', { name: W.removeMarker }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(clearTrail).not.toHaveBeenCalled()
    expect(removeWithTrail).not.toHaveBeenCalled()

    openTrash()
    fireEvent.click(screen.getByRole('menuitem', { name: W.clearTrail }))
    expect(clearTrail).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)

    openTrash()
    fireEvent.click(screen.getByRole('menuitem', { name: W.removeMarkerTrail }))
    expect(removeWithTrail).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(clearTrail).toHaveBeenCalledTimes(1)
  })

  // nothing to ask about: one plain «Entfernen» row
  it('offers the one «Entfernen» where the marker carries no trail', () => {
    const remove = vi.fn()
    const clearTrail = vi.fn()
    render(<TwinTeamPill name="Müller" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ clearTrail, remove, removeWithTrail: () => {} }} />)
    openTrash()
    expect(rowNames()).toEqual([appConfig.copy.remove])
    fireEvent.click(screen.getByRole('menuitem', { name: appConfig.copy.remove }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(clearTrail).not.toHaveBeenCalled()
  })

  // …and the footprint button is gone: one delete, one glyph
  it('draws no second trail button beside the trash', () => {
    const { container } = render(<TwinTeamPill name="Müller" color="#c00" raus={false} trailCount={4} trailShown trupps={TRUPPS}
      acts={{ clearTrail: () => {}, remove: () => {} }} />)
    expect(container.querySelector('.wb-pa-trail')).toBeNull()
    expect(screen.queryByRole('button', { name: W.clearTrail })).toBeNull()
  })

  // a surface that does not offer the combined door draws two rows, not three — the same «a
  // missing writer draws no button» rule every other action here follows
  it('leaves «Marker und Spur löschen» out where the surface has no such writer', () => {
    render(<TwinTeamPill name="Müller" color="#c00" raus={false} trailCount={4} trailShown trupps={TRUPPS}
      acts={{ clearTrail: () => {}, remove: () => {} }} />)
    openTrash()
    expect(rowNames()).toEqual([W.removeMarker, W.clearTrail])
  })
})

// a locked surface (viewer, el, Führungsansicht) passes only the two doors that change nothing
// (RBAC audit 22.10.2026): the jump to the Trupp's card and this device's trail toggle
describe('the view-only bar', () => {
  it('offers «Im Atemschutz zeigen» and «Spur ein/aus», and no trash', () => {
    const showTrupp = vi.fn()
    const toggleTrail = vi.fn()
    render(<TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={3} trailShown trupps={TRUPPS}
      acts={{ showTrupp, toggleTrail }} />)
    expect(screen.queryByRole('button', { name: appConfig.copy.remove })).toBeNull()
    expect(screen.queryByRole('button', { name: A.markerLabel })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.whiteboard.showTrupp }))
    expect(showTrupp).toHaveBeenCalledWith('t1')
    // nothing to write, so «Mehr» holds only the Spuren toggle
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.whiteboard.barMore }))
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual([picked(appConfig.copy.whiteboard.trails)])
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(appConfig.copy.whiteboard.trails) }))
    expect(toggleTrail).toHaveBeenCalledTimes(1)
  })
})

// rare-user round 2, owner pick M12 A (17.11.2026): one Trupp button that changes, «Markieren»,
// «Mehr» – the same buttons with and without «Beschriftung», on phone and tablet alike
describe('the bar', () => {
  const W = appConfig.copy.whiteboard
  const R = appConfig.copy.contextPanel.dockedRelease
  const line = { lineId: 'l1', color: '#00f', tone: 'idle' as const, coupled: true }
  const linked = (pick = vi.fn()) => render(
    <TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={3} trailShown trupps={TRUPPS}
      line={line} originalLabel="Auf Plan zeigen"
      acts={{ unlink: () => {}, showTrupp: () => {}, pick, mark: () => {}, toggleTrail: () => {},
        toOriginal: () => {}, remove: () => {}, clearTrail: () => {} }} />)
  const loose = () => render(
    <TwinTeamPill name="Trupp 3" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ rename: () => {}, pick: () => {}, mark: () => {}, remove: () => {} }} />)
  const bar = (c: HTMLElement) => Array.from(c.querySelectorAll('.wb-pill-acts > button'))
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: W.barMore }))
  const rows = () => screen.getAllByRole('menuitem').map((r) => r.textContent)

  it('stands «Zum Trupp · Markieren · Lösen · Mehr» on a marker on a Leitung, the rest in «Mehr», deletes last', () => {
    const { container } = linked()
    expect(bar(container).map((b) => b.textContent)).toEqual([W.showTrupp, W.markShort, R, W.barMore])
    // the short word on the bar, the full words for the title and the screen reader
    expect(screen.getByRole('button', { name: W.markPosition }).textContent).toBe(W.markShort)
    openMore()
    expect(rows()).toEqual([A.markerLabel, picked(W.trails), 'Auf Plan zeigen', W.removeMarker, W.clearTrail])
    // the Spuren row says it is on, the menu's ✓
    expect(screen.getByRole('menuitem', { name: new RegExp(W.trails) }).querySelector('.de-menu-tick.on')).not.toBeNull()
  })

  it('cuts BOTH bonds with its one «Lösen» on a marker that is on a Leitung and docked to a symbol', () => {
    const unlink = vi.fn()
    const undock = vi.fn()
    const { container } = render(
      <TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={0} trailShown={false}
        trupps={TRUPPS} line={line} acts={{ unlink, undock, showTrupp: () => {}, mark: () => {} }} />)
    expect(bar(container).filter((b) => b.textContent === R)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: R }))
    expect([unlink.mock.calls.length, undock.mock.calls.length]).toEqual([1, 1])
  })

  it('swaps a linked marker\'s «Mehr» to the join list on «Atemschutz-Trupp», and back on reopening', () => {
    const pick = vi.fn()
    linked(pick)
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: A.markerLabel }))
    // the same list the loose marker's button opens – «Kein Trupp» first, since it hangs on a hose
    expect(rows()).toEqual([A.markerNone, picked('Meier Anna')])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Meier Anna/ }))
    expect(pick).toHaveBeenCalledWith('t1')
    openMore()
    expect(rows()[0]).toBe(A.markerLabel)
  })

  it('stands «Atemschutz-Trupp · Markieren · Mehr» on a loose marker, never a second Trupp button', () => {
    const { container } = loose()
    expect(bar(container).map((b) => b.textContent)).toEqual([W.joinShort, W.markShort, W.barMore])
    expect(screen.queryByRole('button', { name: W.showTrupp })).toBeNull()
    openMore()
    expect(rows()).toEqual([appConfig.copy.edit, appConfig.copy.remove])
    // «Bearbeiten» opens the pill's name field
    fireEvent.click(screen.getByRole('menuitem', { name: appConfig.copy.edit }))
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Trupp 3')
  })

  it('draws no «Mehr» where it would have no row', () => {
    render(<TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ showTrupp: () => {}, mark: () => {} }} />)
    expect(screen.queryByRole('button', { name: W.barMore })).toBeNull()
  })

  it('is the same buttons as bare glyphs with «Beschriftung» off', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    const { container } = linked()
    expect(container.querySelector('.wb-pa-word')).toBeNull()
    expect(bar(container).map((b) => b.getAttribute('aria-label'))).toEqual([W.showTrupp, W.markPosition, R, W.barMore])
  })
})

describe('the storey badge', () => {
  it('states the Geschoss the Trupp is working on, signed like a Leitung’s floor tag', () => {
    const { container } = render(<TwinTeamPill name="Müller" color="#c00" raus={false} floor={2} trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(container.querySelector('.team-floor')?.textContent).toBe('+2')
    cleanup()
    // EG and a Untergeschoss read as themselves — a Trupp is as often in the Keller as upstairs
    const eg = render(<TwinTeamPill name="Müller" color="#c00" raus={false} floor={0} trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(eg.container.querySelector('.team-floor')?.textContent).toBe('0')
    cleanup()
    const ug = render(<TwinTeamPill name="Müller" color="#c00" raus={false} floor={-1} trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(ug.container.querySelector('.team-floor')?.textContent).toBe('−1')
  })

  it('says nothing for a Trupp that is on no storey — a «0» would assert an EG nobody stated', () => {
    const { container } = render(<TwinTeamPill name="Müller" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(container.querySelector('.team-floor')).toBeNull()
  })
})

// round 18.11.2026, owner picks M1 A (phone) + A «✥ ⟳ twin» (tablet, desktop): beside the marker
// the card + bar ran off the screen – on every size they dock at the foot (the CSS places them)
describe('the card and the bar dock at the foot of the surface', () => {
  const W = appConfig.copy.whiteboard
  afterEach(() => { document.querySelectorAll('.maplibregl-map').forEach((m) => m.remove()) })
  /** the pill as the Karte draws it: inside a marker, inside the map's container */
  const onKarte = (props: Partial<Parameters<typeof TwinTeamPill>[0]> = {}) => {
    const map = document.body.appendChild(document.createElement('div'))
    map.className = 'maplibregl-map'
    const marker = map.appendChild(document.createElement('div'))
    render(<TwinTeamPill name="Meier Anna" time="00:47" color="#c00" raus truppId="t1" trailCount={0} trailShown={false}
      trupps={[{ ...TRUPPS[0], status: 'raus' }]} acts={{ showTrupp: () => {}, mark: () => {} }} {...props} />, { container: marker })
    return { map, marker }
  }

  it('portals card and bar into the surface, and leaves the ringed name alone on the marker', () => {
    const close = vi.fn()
    const { map, marker } = onKarte({ onClose: close })
    const card = map.querySelector(':scope > .wb-pill-dock > .wb-pill-card')
    expect(card?.textContent).toContain('Meier Anna')
    expect(card?.querySelector('.wb-resource-time')?.textContent).toBe('00:47')
    expect(card?.querySelector('.wb-resource-raus')).toBeTruthy()
    expect(map.querySelector(':scope > .wb-pill-dock > .wb-pill-acts.docked')).toBeTruthy()
    // on the marker: the name, no state word, no time, no bar
    const onSurface = marker.querySelector('.wb-resource-pill')
    expect(onSurface?.hasAttribute('data-docked')).toBe(true)
    expect(onSurface?.textContent).toBe('Meier Anna')
    expect(marker.querySelector('.wb-pill-acts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  // round 18.11.2026 evening, owner: «when joined, also always show the unjoin button»
  it('stands «Lösen» on the bar while the marker is docked to a symbol – never in «Mehr»', () => {
    const undock = vi.fn()
    const lösen = appConfig.copy.contextPanel.dockedRelease
    const { map } = onKarte({ acts: { showTrupp: () => {}, mark: () => {}, remove: () => {}, undock } })
    const bar = within(map.querySelector<HTMLElement>('.wb-pill-acts.docked')!)
    expect(bar.getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual([W.showTrupp, W.markPosition, lösen, W.barMore])
    fireEvent.click(bar.getByRole('button', { name: lösen }))
    expect(undock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: W.barMore }))
    expect(screen.queryByRole('menuitem', { name: lösen })).toBeNull()
  })

  it('…and no «Lösen» at all on a marker that is docked to nothing', () => {
    onKarte({ acts: { showTrupp: () => {}, mark: () => {}, remove: () => {} } })
    expect(screen.queryByRole('button', { name: appConfig.copy.contextPanel.dockedRelease })).toBeNull()
  })

  it('keeps a press on the card from reaching the marker under it (React bubbles a portal)', () => {
    const press = vi.fn()
    const map = document.body.appendChild(document.createElement('div'))
    map.className = 'maplibregl-map'
    render(<div onPointerDown={press}><TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={0} trailShown={false}
      trupps={TRUPPS} acts={{ showTrupp: () => {}, mark: () => {} }} /></div>, { container: map.appendChild(document.createElement('div')) })
    fireEvent.pointerDown(map.querySelector('.wb-pill-card')!)
    fireEvent.pointerDown(screen.getByRole('button', { name: W.markPosition }))
    expect(press).not.toHaveBeenCalled()
  })
})
