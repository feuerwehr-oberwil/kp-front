// The «Ort» card of a visit at a PLACE (no catalogue object, docs/object-visits.md · «The target»):
// a small aerial snippet with the pin, the label with its «Pin»/«Adresse» badge, LV95, and one
// line saying there is no station object and where the report is filed. It stands where an object
// visit shows its address line. In the read view the same place is one line (PlaceLine).
//
// The snippet is plain raster tiles around the point (place · placeTiles), no map library: offline
// a tile the device never saw does not load and the card keeps everything else.

import { useMemo, useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { fmtLV95 } from '../../lib/geo'
import { defaultLayers } from '../../lib/workspace'
import { placeKind, placeTiles } from '../../objectVisits/place'
import type { PlaceTarget } from '../../objectVisits/types'
import s from './ObjectVisits.module.css'

/** The plane the tiles are laid out on; the card shows its middle. */
const PLANE_W = 720
const PLANE_H = 128
const ZOOM = 18

/** The station's aerial base (the «Satellit» layer), else its first raster base — null without one. */
function aerialTemplate(): string | null {
  const bases = defaultLayers().filter((l) => l.base && Array.isArray(l.tiles) && l.tiles.length > 0)
  const air = bases.find((l) => l.id === 'base-air' || l.icon === 'sat') ?? bases[0]
  return air?.tiles?.[0] ?? null
}

export function PlaceCard({ place, filing }: { place: PlaceTarget; filing: string | null }) {
  const C = appConfig.copy.objectVisits
  const tiles = useMemo(() => {
    const tpl = aerialTemplate()
    return tpl ? placeTiles(tpl, place.lat, place.lng, ZOOM, PLANE_W, PLANE_H) : []
  }, [place.lat, place.lng])
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const kind = placeKind(place)
  return (
    <div className={`${s.card} ${s.cardPad}`} data-testid="ov-place-card">
      <span className={s.fieldLabel}>{C.placeCard}</span>
      {tiles.length > 0 && (
        <div className={s.miniMap} aria-hidden>
          <div className={s.miniPlane} style={{ width: PLANE_W, height: PLANE_H }}>
            {tiles.map((t) => !failed.has(t.key) && (
              <img key={t.key} src={t.url} alt="" draggable={false} loading="lazy"
                style={{ left: t.left, top: t.top }}
                onError={() => setFailed((f) => new Set(f).add(t.key))} />
            ))}
          </div>
          <svg className={s.miniPin} viewBox="0 0 34 44" aria-hidden>
            <path d="M17 43C17 43 3 26 3 16a14 14 0 0 1 28 0c0 10-14 27-14 27z" />
            <circle cx="17" cy="16" r="5" />
          </svg>
        </div>
      )}
      <div className={s.placeHead}>
        <span className={s.placeLabel}>{place.label}</span>
        <span className="ip-badge ip-badge-arch">{kind === 'address' ? C.placeAddress : C.placePin}</span>
      </div>
      {place.address && kind === 'pin' && <span className={s.sumText}>{place.address}</span>}
      <span className={s.mono}>LV95 {fmtLV95(place.lng, place.lat)}</span>
      <p className={s.placeNote}>{filing ? fillTemplate(C.placeNote, { folder: filing }) : C.placeNoteNoFiling}</p>
    </div>
  )
}

/** The place as one line, where an object visit shows its address (the finished visit). */
export function PlaceLine({ place }: { place: PlaceTarget }) {
  return (
    <p className={s.place}><Icon id="pin" />{`${place.label} · LV95 ${fmtLV95(place.lng, place.lat)}`}</p>
  )
}
