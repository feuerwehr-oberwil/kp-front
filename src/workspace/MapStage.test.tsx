// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MapStage, type MapStageProps } from './MapStage'
import { useMapActions, type UseMapActionsInputs } from './useMapActions'
import type { MapView } from '../components/MapView'
import type { TacticalObject } from '../lib/tacticalObjects'
import type { Entity } from '../types'

// MapView is the one child that matters here: the test reads the handlers MapStage hands it.
const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('../components/MapView', () => ({ MapView: (p: Record<string, unknown>) => { seen.props = p; return null } }))
vi.mock('../lib/ui', () => ({ toast: vi.fn(), confirmDialog: vi.fn(async () => true), undoToast: vi.fn() }))
import { undoToast } from '../lib/ui'

/** Any input not named stands in as an inert, endlessly nestable stub. */
const inert = (): unknown => new Proxy(() => undefined, {
  get: (_, k) => (k === 'then' || typeof k === 'symbol' ? undefined : inert()),
  apply: () => undefined,
})
const withInert = <T,>(given: Partial<T>): T => new Proxy(given, {
  get: (t, k) => (k in t ? t[k as keyof typeof t] : inert()),
}) as T

const host: Entity = { id: 'v1', kind: 'vehicle', layer: 'l', coord: [7.5, 47.5], label: 'TLF' } as Entity
const marker: Entity = { id: 'm1', kind: 'team', layer: 'l', coord: [7.5, 47.5], label: 'Trupp 1', dockedTo: 'v1' }

// The pill's «Lösen» on a docked Trupp marker lets go the way the Trupp panel's «Lösen» does
// (useMapActions · undockTeam): one row, and a «Gelöst · Rückgängig» toast whose undo docks it back.
describe('MapStage — the marker pill\'s «Lösen»', () => {
  afterEach(() => { vi.clearAllMocks(); seen.props = null })

  it('raises the undo toast, and its undo restores the dock', () => {
    const patchEntity = vi.fn()
    const log = vi.fn()
    const doc = { entities: [host, marker], drawings: [] }
    const objectsRef = { current: [{ entity: host }, { entity: marker }] as unknown as TacticalObject[] }
    function Stage() {
      const mapActions = useMapActions(withInert<UseMapActionsInputs>({
        doc: doc as unknown as UseMapActionsInputs['doc'], entities: doc.entities, drawings: [], patchEntity, log, objectsRef,
        tacticalLocked: false, liveIds: new Set(), planDocs: [], trupps: [], objects: [], mode: 'map', selectedDrawIds: [], selectedEntityIds: [],
      }))
      // called, not mounted: JSX would copy only the named props, and MapStage has no hooks
      return MapStage(withInert<MapStageProps>({
        sym: { ready: true } as MapStageProps['sym'], guarded: (_s, node) => <>{node}</>,
        tacticalLocked: false, store: { doc } as unknown as MapStageProps['store'], patchEntity, mapActions, trails: [],
      }))
    }
    render(<Stage />)
    const onTeamUndock = (seen.props as ComponentProps<typeof MapView> | null)?.onTeamUndock
    act(() => { onTeamUndock?.('m1') })
    expect(patchEntity).toHaveBeenCalledWith('m1', { dockedTo: undefined })
    expect(undoToast).toHaveBeenCalledTimes(1)
    // the marker is loose now; the toast's undo docks it back onto the host
    objectsRef.current = [{ entity: host }, { entity: { ...marker, dockedTo: undefined } }] as unknown as TacticalObject[]
    const undo = vi.mocked(undoToast).mock.calls[0][1]
    act(() => { undo() })
    expect(patchEntity).toHaveBeenLastCalledWith('m1', { dockedTo: 'v1' })
  })
})
