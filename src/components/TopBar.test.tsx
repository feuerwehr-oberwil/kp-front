// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TopBar } from './TopBar'
import { appConfig } from '../config/appConfig'
import type { Incident } from '../types'

// «Teilen» in the Einsatzkopf is THE place this app hands an Einsatz to somebody, and every row
// hands out an address that lets a stranger read — or, for the Truppüberwacher, operate — it. So
// what is worth pinning is the GATE and the completeness of the list, not the look: all three
// links are reachable from this one control, and the whole button is absent where sharing is not
// allowed. Everything upstream (viewer, read-only/archived, link session) reaches this component
// as an absent callback, which is why «no callback → no button» is the whole matrix from here.

const C = appConfig.copy.topBar

const incident: Incident = {
  type: 'Brand', title: 'Brand Hauptstrasse 4', address: 'Hauptstrasse 4', center: [7.5, 47.5],
  startedAt: new Date().toISOString(), durationSec: 0, offline: false, cachedTiles: 0,
  recording: false, recDurationSec: 0,
}

function bar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      incident={incident} recording={false} recStartedAt={null}
      journalOpen={false} onToggleJournal={() => {}}
      onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false}
      {...props}
    />,
  )
}

afterEach(cleanup)

describe('«Teilen» im Einsatzkopf', () => {
  it('is absent for anybody who may not hand this Einsatz out', () => {
    bar()
    expect(screen.queryByRole('button', { name: C.share })).toBeNull()
  })

  // The point of the 03.09. consolidation: which link you get is decided by the row you pick,
  // never by which door you happened to find. A missing row here IS a link only reachable
  // somewhere else, which is the state this replaced.
  it('offers all three links, and each row names the one it opens', () => {
    const onShare = vi.fn()
    bar({ onShare })

    fireEvent.click(screen.getByRole('button', { name: C.share }))
    for (const [label, door] of [
      [C.shareEinsatz, 'einsatz'],
      [C.shareAtemschutz, 'atemschutz'],
      [C.shareRapport, 'view'],
    ] as const) {
      expect(screen.getByText(label)).toBeTruthy()
      fireEvent.click(screen.getByText(label))
      expect(onShare).toHaveBeenLastCalledWith(door)
      fireEvent.click(screen.getByRole('button', { name: C.share })) // the row closed the menu
    }
    expect(onShare).toHaveBeenCalledTimes(3)
  })

  // After the Abschluss two of the three are dead addresses (the server refuses to mint an
  // Einsatz-Link on a closed Einsatz, and an Atemschutz link to one 404s), so they must not be
  // offered. The Rapport-Link is the one that outlives the Einsatz — and the one somebody comes
  // back for days later — so the button stays, with that row alone.
  it('drops the links that die with the Abschluss, and keeps the one that does not', () => {
    const onShare = vi.fn()
    bar({ onShare, archived: true })
    fireEvent.click(screen.getByRole('button', { name: C.share }))
    expect(screen.getByText(C.shareRapport)).toBeTruthy()
    expect(screen.queryByText(C.shareEinsatz)).toBeNull()
    expect(screen.queryByText(C.shareAtemschutz)).toBeNull()
  })

  // …and the second line, because the first and third row are otherwise the same sentence: both
  // are «ganzer Einsatz, nur lesen», and the only thing that picks between them is the lifetime.
  it('says how long each one lasts', () => {
    bar({ onShare: () => {} })
    fireEvent.click(screen.getByRole('button', { name: C.share }))
    expect(screen.getByText(C.shareEinsatzSub)).toBeTruthy()
    expect(screen.getByText(C.shareRapportSub)).toBeTruthy()
  })
})
