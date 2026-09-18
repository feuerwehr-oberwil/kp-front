// @vitest-environment jsdom
/**
 * The ghosting as the incident actually runs it (lib/useGhostTrails): markers standing on the
 * picture, a removal, and what the trails collection says afterwards. The pure fold is covered in
 * truppTrails.test — what is pinned HERE is the wiring the surfaces depend on, because that is
 * where it broke: an effect that reconciled without the armed drop left «Marker und Spur löschen»
 * removing the marker, writing «Spur gelöscht» into the Verlauf, and leaving the searched area
 * standing on the picture.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { liveGhostTrails, type TrailSource, type TruppTrail } from './truppTrails'
import { useGhostTrails } from './useGhostTrails'

afterEach(cleanup)

const walked: TrailSource = {
  sourceId: 'a1', truppId: 'tr1', truppNo: 3, name: 'Müller Hans', planId: 'gebaeude', floorStack: true,
  points: [{ x: 0.4, y: 0.5, t: '03:11', floor: 2 }, { x: 0.6, y: 0.5, t: '03:14', floor: 2 }],
}

/** A stand-in for the surfaces + IncidentWorkspace: markers in state, the hook over them, and
 *  the two doors a Trupp marker's trash offers. */
function Harness({ onTrails }: { onTrails: (ts: TruppTrail[]) => void }) {
  const [sources, setSources] = useState<TrailSource[]>([walked])
  const [trails, setTrails] = useState<TruppTrail[]>([])
  const { armTrailDrop, reseed } = useGhostTrails({
    sources,
    setTrails: (up) => setTrails((ts) => { const next = up(ts); onTrails(next); return next }),
  })
  return (
    <>
      {/* «Marker entfernen» — the searched area outlives the marker */}
      <button onClick={() => setSources([])}>remove</button>
      {/* «Marker und Spur löschen» — armed in the same breath as the removal */}
      <button onClick={() => { armTrailDrop('a1', true); setSources([]) }}>remove+trail</button>
      {/* …and the ask that was declined: armed, then taken back, marker still standing */}
      <button onClick={() => { armTrailDrop('a1', true); armTrailDrop('a1', false) }}>arm-then-cancel</button>
      {/* an arming whose removal never happened (the connection ask said «Abbrechen») */}
      <button onClick={() => armTrailDrop('a1', true)}>arm only</button>
      {/* a marker moving is an ordinary pass — it is what SPENDS a stale intent */}
      <button onClick={() => setSources([{ ...walked, name: 'Müller H.' }])}>touch</button>
      <button onClick={() => { reseed(); setSources([]) }}>hydrate</button>
      <span data-testid="live">{liveGhostTrails(trails).length}</span>
      <span data-testid="rows">{trails.length}</span>
    </>
  )
}

const press = (label: string) => act(() => { fireEvent.click(screen.getByText(label)) })
const live = () => screen.getByTestId('live').textContent
const rows = () => screen.getByTestId('rows').textContent

describe('the ghost-trail reconciliation as the incident runs it', () => {
  it('«Marker entfernen» leaves the searched area standing', () => {
    render(<Harness onTrails={() => {}} />)
    press('remove')
    expect(live()).toBe('1')
  })

  it('«Marker und Spur löschen» leaves NO live ghost — the stamp is written in the same pass', () => {
    render(<Harness onTrails={() => {}} />)
    press('remove+trail')
    expect(live()).toBe('0')
    // the row IS written, stamped: skipping it would only be ghosted again by the next pass,
    // and a stamp is what the collection already means by «deliberately deleted»
    expect(rows()).toBe('1')
  })

  it('takes the arming back when the removal is called off, and ghosts normally afterwards', () => {
    render(<Harness onTrails={() => {}} />)
    press('arm-then-cancel')
    press('remove')
    expect(live()).toBe('1')
  })

  it('spends a stale arming on the next pass, so it cannot eat a later removal’s trail', () => {
    render(<Harness onTrails={() => {}} />)
    press('arm only')   // the removal that was armed never happened
    press('touch')      // …and the next ordinary pass consumes the intent
    press('remove')
    expect(live()).toBe('1')
  })

  it('ghosts nothing after a remote hydrate — the store was replaced, not emptied', () => {
    render(<Harness onTrails={() => {}} />)
    press('hydrate')
    expect(rows()).toBe('0')
  })
})
