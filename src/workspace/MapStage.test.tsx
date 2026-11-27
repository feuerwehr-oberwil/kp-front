// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { WorkspaceMode } from './types'
import type { ComponentProps } from 'react'
import { MapStage, type MapStageProps } from './MapStage'
import { useMapActions, type UseMapActionsInputs } from './useMapActions'
import type { MapView } from '../components/MapView'
import type { TacticalObject } from '../lib/tacticalObjects'
import type { Entity } from '../types'

// MapView is the one child that matters here: the test reads the handlers MapStage hands it.
const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, renders: 0 }))
vi.mock('../components/MapView', () => ({ MapView: (p: Record<string, unknown>) => { seen.props = p; seen.renders++; return null } }))
vi.mock('../lib/ui', () => ({ toast: vi.fn(), confirmDialog: vi.fn(async () => true), undoToast: vi.fn() }))
import { toast, undoToast } from '../lib/ui'

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
// (useMapActions · undockTeam): one row, one Karte write (its ↶ step docks it back) – no toast,
// owner pick 28 (17.11.2026).
describe('MapStage — the marker pill\'s «Lösen»', () => {
  afterEach(() => { vi.clearAllMocks(); seen.props = null })

  it('lets go with one write and one row, and raises no toast', () => {
    const patchEntity = vi.fn()
    const log = vi.fn()
    const doc = { entities: [host, marker], drawings: [] }
    const objectsRef = { current: [{ entity: host }, { entity: marker }] as unknown as TacticalObject[] }
    function Stage() {
      const mapActions = useMapActions(withInert<UseMapActionsInputs>({
        doc: doc as unknown as UseMapActionsInputs['doc'], entities: doc.entities, drawings: [], patchEntity, log, objectsRef,
        tacticalLocked: false, liveIds: new Set(), planDocs: [], trupps: [], objects: [], mode: 'map', selectedDrawIds: [], selectedEntityIds: [],
      }))
      // called, not mounted: JSX would copy only the named props; its hooks run as Stage's
      return MapStage(withInert<MapStageProps>({
        sym: { ready: true } as MapStageProps['sym'], guarded: (_s, node) => <>{node}</>,
        tacticalLocked: false, store: { doc } as unknown as MapStageProps['store'], patchEntity, mapActions, trails: [],
      }))
    }
    render(<Stage />)
    const onTeamUndock = (seen.props as ComponentProps<typeof MapView> | null)?.onTeamUndock
    act(() => { onTeamUndock?.('m1') })
    expect(patchEntity).toHaveBeenCalledTimes(1)
    expect(patchEntity).toHaveBeenCalledWith('m1', { dockedTo: undefined })
    expect(log).toHaveBeenCalledTimes(1)
    expect(undoToast).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})

// The Karte renders only where its output is seen or used (FreezableMapView): its own surface, a
// georef split, a plan whose twins take its caption decisions. A frozen one renders no new props;
// the first commit that needs it again does.
describe('MapStage — the frozen map', () => {
  it('renders on the Karte and behind a plan with twins; sits out every other commit', () => {
    // the workspace's ref is one object for its life – a new ref would render a memo anyway
    const mapRef = { current: null }
    function Stage({ mode, planTwins }: { mode: WorkspaceMode; planTwins: boolean; n: number }) {
      return MapStage(withInert<MapStageProps>({
        sym: { ready: true } as MapStageProps['sym'], guarded: (_s, node) => <>{node}</>,
        store: { doc: { entities: [], drawings: [] } } as unknown as MapStageProps['store'], trails: [], mode, planTwins, mapRef,
      }))
    }
    seen.renders = 0
    const r = render(<Stage mode="map" planTwins={false} n={0} />)
    r.rerender(<Stage mode="map" planTwins={false} n={1} />)
    expect(seen.renders).toBe(2)
    r.rerender(<Stage mode="atemschutz" planTwins={false} n={2} />)
    r.rerender(<Stage mode="atemschutz" planTwins={false} n={3} />)
    r.rerender(<Stage mode="plans" planTwins={false} n={4} />)
    expect(seen.renders).toBe(2)
    r.rerender(<Stage mode="plans" planTwins n={5} />)
    r.rerender(<Stage mode="plans" planTwins n={6} />)
    expect(seen.renders).toBe(4)
    r.rerender(<Stage mode="map" planTwins={false} n={7} />)
    expect(seen.renders).toBe(5)
  })
})
