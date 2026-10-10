// The Tafel's pages, as the Whiteboard needs them (10.10.2026): the station's board-template set
// (lib/boardTemplates, warmed once), what a new page may be pre-filled with (lib/boardSeed), and
// the live mini Karte a «Lagekarte» box shows. Kept out of IncidentWorkspace so the workspace
// only hands over what it already holds.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { TafelPagesProps } from '../components/Whiteboard'
import type { BoardTemplate } from '../lib/boardTemplate'
import { boardSeedFrom } from '../lib/boardSeed'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import type { FahrzeugZeit } from '../lib/workspace'
import type { CaptionMode, Drawing, Entity, LayerDef, LayerId, LngLat, Trupp } from '../types'
import { MiniKarte } from './lazySurfaces'

export interface TafelPagesSources {
  /** false for an Einsatz-Link session: bound to one object, it gets the free sheet only */
  enabled: boolean
  title: string
  address?: string | null
  alarmIso?: string | null
  einsatzleiter?: string | null
  fahrzeuge?: readonly FahrzeugZeit[] | null
  /** the Karte's own objects (the seed reads the placed vehicles off them) */
  docEntities: Entity[]
  /** …and what the Karte DRAWS, for the mini Karte */
  mapEntities: Entity[]
  drawings: Drawing[]
  layers: LayerDef[]
  isVisible: (id: LayerId) => boolean
  byName: Record<string, string>
  center: LngLat
  symMul: number
  captionMode: CaptionMode
  trupps: Trupp[]
  openKarte: () => void
}

export function useTafelPages(src: TafelPagesSources): TafelPagesProps | undefined {
  // the set (and the bundled FKS file behind it) loads with the Tafel's own code, never on the
  // boot path — an empty list for the few ms before it lands only means «+ Seite» lists nothing
  const [templates, setTemplates] = useState<readonly BoardTemplate[]>([])
  useEffect(() => {
    if (!src.enabled) return
    let live = true
    void import('../lib/boardTemplates').then((m) => m.warmBoardTemplates()).then((t) => { if (live) setTemplates(t) })
    return () => { live = false }
  }, [src.enabled])
  // the seed is read at the TAP, so it sees the Einsatz as it is then — through a ref
  const latest = useRef(src)
  useEffect(() => { latest.current = src })
  // the mini Karte re-renders with the Lage, and only while a page with a map box is mounted
  const { mapEntities, drawings, layers, isVisible, byName, center, symMul, captionMode, trupps } = src
  const renderMap = useMemo(() => () => (
    <Suspense fallback={null}>
      <MiniKarte entities={mapEntities} drawings={drawings} layers={layers} isVisible={isVisible} byName={byName}
        center={center} symMul={symMul} captionMode={captionMode} trupps={trupps} />
    </Suspense>
  ), [mapEntities, drawings, layers, isVisible, byName, center, symMul, captionMode, trupps])
  return useMemo(() => (src.enabled ? {
    templates,
    seed: () => {
      const s = latest.current
      return boardSeedFrom({
        title: s.title, address: s.address, alarmIso: s.alarmIso, einsatzleiter: s.einsatzleiter,
        fahrzeuge: s.fahrzeuge, fleet: getDeploymentConfig().fleet?.vehicles, entities: s.docEntities,
      })
    },
    renderMap,
    onOpenKarte: () => latest.current.openKarte(),
  } : undefined), [src.enabled, templates, renderMap])
}
