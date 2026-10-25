import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LineEndpoint, LngLat } from '../types'
import { buzz } from '../lib/haptics'
import { dockRadiusFor, nearestDockHost } from '../lib/docking'
import { MAGNET_DWELL_MS, nearestFreeEndpoint, TEAM_JOIN_RADIUS_PX } from '../lib/lineAttachments'

type TeamJoinAim = { entityId: string; lineId: string; endpoint: LineEndpoint; coord: LngLat; since: number; armed: boolean }
type DockAim = { entityId: string; hostId: string; coord: LngLat; since: number; armed: boolean }

export interface TruppMarkerAimDeps {
  mapInst: RefObject<MlMap | null>
  entities: Entity[]
  /** the Leitungen that may still take a Trupp (MapView · openHoseLines), resolved coords */
  openHoseLines: Drawing[]
  /** hoses are drawn on this surface right now (lib/mapView · nativeDrawingChromeVisible) */
  nativeDrawingChrome: boolean
  onMarkerMove: (id: string, c: LngLat) => void
  onMarkerDragEnd: (id: string, c: LngLat, join?: { lineId: string; endpoint: LineEndpoint } | null, dock?: { hostId: string } | null) => void
}

/**
 * ── Truppmarker auf ein freies Leitungsende: derselbe Magnet, von der anderen Seite ──
 *
 * Dropping a Trupp's marker on the free end of a hose joins the two — the same link that
 * snapping the hose onto the marker makes, from whichever side the operator happens to work.
 * Until 15.09. that happened INVISIBLY on release: nothing said a hose end was free, nothing
 * said the drop had found one, and a marker parked near a hose could couple to it by accident.
 *
 * It now wears the picture every other attachment on this surface wears — «Ring lädt, dann
 * schnappt es» — and the whole contract comes with it: **not armed = nothing attaches, not
 * even on release** (docs/ui-conventions.md · Touch vocabulary). The aim is reported to the drop through
 * `onMarkerDragEnd`, so the writer never re-guesses what the ring promised.
 *
 * ⚠️ `TEAM_JOIN_RADIUS_PX`, not `MAGNET_RADIUS_PX`: this gesture aims with the marker's LEFT
 * EDGE (the dot on its coordinate), not with the finger — see the constant's own note.
 *
 * MapView hands MapMarkers `teamJoinMarkerMove` / `teamJoinMarkerDragEnd` in place of the bare
 * marker writers, and draws `teamJoin` / `dockAim` as rings.
 */
export function useTruppMarkerAim({ mapInst, entities, openHoseLines, nativeDrawingChrome, onMarkerMove, onMarkerDragEnd }: TruppMarkerAimDeps) {
  const [teamJoin, setTeamJoinState] = useState<TeamJoinAim | null>(null)
  const teamJoinRef = useRef<TeamJoinAim | null>(null)
  const teamJoinTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** a Trupp marker is in the hand — what turns the free couplings on (they are an answer to
   *  this gesture, not permanent furniture: a Lage with a dozen hoses would grow a dozen rings) */
  const [teamDragId, setTeamDragId] = useState<string | null>(null)
  const setTeamJoin = (next: TeamJoinAim | null) => { teamJoinRef.current = next; setTeamJoinState(next) }
  /** …and the OTHER thing a Trupp marker in the hand can land on: a symbol to dock to
   *  (lib/docking). The same ring, the same hold («Halten zum Verbinden»): it fills on the host
   *  while the marker hovers inside the dock radius, and only a CLOSED ring docks on release –
   *  a marker merely carried past a symbol must not stick to it. The hose join above wins when
   *  both are in reach; the dock ring then does not show at all. */
  const [dockAim, setDockAimState] = useState<DockAim | null>(null)
  const dockAimRef = useRef<DockAim | null>(null)
  const dockAimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setDockAim = (next: DockAim | null) => { dockAimRef.current = next; setDockAimState(next) }
  const clearDockAim = () => {
    if (dockAimTimer.current) { clearTimeout(dockAimTimer.current); dockAimTimer.current = null }
    if (dockAimRef.current) setDockAim(null)
  }
  useEffect(() => () => { if (dockAimTimer.current) clearTimeout(dockAimTimer.current) }, [])
  const trackDockAim = (id: string, c: LngLat) => {
    const map = mapInst.current
    const me = entities.find((e) => e.id === id)
    if (!map || me?.kind !== 'team' || teamJoinRef.current) { clearDockAim(); return }
    const host = nearestDockHost(c, entities.filter((e) => e.id !== id), (q) => map.project(q as [number, number]), dockRadiusFor(me))
    if (!host || !Array.isArray(host.coord)) { clearDockAim(); return }
    // still over the same host: let the ring keep filling rather than restarting it
    if (dockAimRef.current?.entityId === id && dockAimRef.current.hostId === host.id) return
    clearDockAim()
    const st: DockAim = { entityId: id, hostId: host.id, coord: host.coord as LngLat, since: Date.now(), armed: false }
    setDockAim(st)
    dockAimTimer.current = setTimeout(() => {
      const now = dockAimRef.current
      if (!now || now.since !== st.since) return
      setDockAim({ ...now, armed: true })
      buzz() // …on arm, and only on arm (docs/ui-conventions.md · Touch vocabulary)
    }, MAGNET_DWELL_MS)
  }
  const clearTeamJoin = () => {
    if (teamJoinTimer.current) { clearTimeout(teamJoinTimer.current); teamJoinTimer.current = null }
    if (teamJoinRef.current) setTeamJoin(null)
  }
  useEffect(() => () => { if (teamJoinTimer.current) clearTimeout(teamJoinTimer.current) }, [])
  /** the hose ends the marker is being aimed at, per drag move — mirrors usePlaceMagnet's track */
  const trackTeamJoin = (id: string, at: LngLat) => {
    const map = mapInst.current
    const ent = entities.find((x) => x.id === id)
    // only a Trupp marker joins, and only where hoses are actually drawn
    if (!map || ent?.kind !== 'team' || !ent.truppId || !nativeDrawingChrome) { clearTeamJoin(); return }
    if (teamDragId !== id) setTeamDragId(id)
    const p = map.project(at as [number, number])
    const hit = nearestFreeEndpoint(
      [p.x, p.y],
      // …and never a Leitung that already has a crew: `openHoseLines` is the same «one Trupp per
      // line» filter the rings are drawn from, so the ring and the aim can never disagree
      openHoseLines.flatMap((d) => (d.kind === 'line' && Array.isArray(d.coords) && d.coords.length >= 2
        ? [{ id: d.id, points: d.coords, startAttachment: d.startAttachment, endAttachment: d.endAttachment }] : [])),
      (c) => { const q = map.project(c as [number, number]); return [q.x, q.y] },
      TEAM_JOIN_RADIUS_PX,
      ['end'],
    )
    if (!hit) { clearTeamJoin(); return }
    const cur = teamJoinRef.current
    // still on the same end: let the ring keep filling rather than restarting it
    if (cur && cur.entityId === id && cur.lineId === hit.lineId && cur.endpoint === hit.endpoint) return
    clearTeamJoin()
    const ll = map.unproject(hit.point as [number, number])
    const st: TeamJoinAim = { entityId: id, lineId: hit.lineId, endpoint: hit.endpoint, coord: [ll.lng, ll.lat], since: Date.now(), armed: false }
    setTeamJoin(st)
    teamJoinTimer.current = setTimeout(() => {
      const now = teamJoinRef.current
      if (!now || now.since !== st.since) return
      setTeamJoin({ ...now, armed: true })
      buzz() // …on arm, and only on arm (docs/ui-conventions.md · Touch vocabulary)
    }, MAGNET_DWELL_MS)
  }
  const teamJoinMarkerMove = (id: string, c: LngLat) => { onMarkerMove(id, c); trackTeamJoin(id, c); trackDockAim(id, c) }
  const teamJoinMarkerDragEnd = (id: string, c: LngLat) => {
    const aim = teamJoinRef.current
    // only a CLOSED ring joins; everything else is an ordinary drop that moved a marker
    const join = aim?.armed && aim.entityId === id ? { lineId: aim.lineId, endpoint: aim.endpoint } : null
    // …and the dock, the same way: a closed ring docks, an open one is an ordinary drop. Only a
    // Trupp marker has an opinion here; a placard leaves it undefined and docks instantly, as
    // it always did (IncidentWorkspace · finishEntityMove).
    const da = dockAimRef.current
    const dock = entities.find((e) => e.id === id)?.kind === 'team'
      ? (da?.armed && da.entityId === id ? { hostId: da.hostId } : null)
      : undefined
    clearTeamJoin()
    clearDockAim()
    setTeamDragId(null)
    onMarkerDragEnd(id, c, join, dock)
  }

  return { teamJoin, dockAim, teamDragId, setTeamDragId, teamJoinMarkerMove, teamJoinMarkerDragEnd }
}
