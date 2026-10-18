// «Karte & Objekte» — the search results under the bar: station objects first (found on the
// device, offline too — lib/karte/search), then addresses from the geocoder (online only).
// An empty query lists the station objects nearest the map centre, nearest first (lib/karte/search ·
// nearestObjects; owner, review round 11: «have more items to scroll through»), as hit rows.
//
// A row is glyph · name · address (· distance for a hit) — no plan count (owner, review round 2:
// «we don't need the number of modules on the index. just the address is enough»; the sheet
// lists the plans). The address line is lib/karte/places · objectRowSub: never the kind word
// standing in for an address, and a name that IS the address is not printed twice.
//
// On a phone the list is the body of the search's slide-up (`inSheet`, KarteApp · KarteKeySheet,
// review round 3) rather than a card hung from the bar: the sheet is its frame and its scroller.

import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { fmtDistance } from '../../lib/geo'
import type { GeoHit } from '../../lib/api/geo'
import type { ObjectHit } from '../../lib/karte/search'
import { objectRowSub, splitAddress } from '../../lib/karte/places'
import s from './Karte.module.css'

export type AddrState = 'idle' | 'short' | 'loading' | 'ok' | 'offline' | 'error'

export function KarteSearch({ query, hits, nearest, addresses, addrState, onPickObject, onPickAddress, inSheet = false }: {
  query: string
  hits: ObjectHit[]
  /** shown while nothing is typed: the objects nearest the map centre */
  nearest: ObjectHit[]
  addresses: GeoHit[]
  addrState: AddrState
  onPickObject: (id: string) => void
  onPickAddress: (hit: GeoHit) => void
  /** inside the phone's search sheet: no frame of its own */
  inSheet?: boolean
}) {
  const C = appConfig.copy.karte
  const q = query.trim()
  const lead = () => <span className={s.rowLead}><Icon id="footprint" /></span>
  // a station object: glyph · name · address · distance (or «no coordinates»)
  const objectRows = (list: ObjectHit[]) => (
    <div className={s.list}>
      {list.map(({ obj: o, distanceM, approx }) => (
        <button key={o.id} type="button" role="option" aria-selected={false} className={s.row} onClick={() => onPickObject(o.id)}>
          {lead()}
          <span className={s.rowText}><b>{o.name}</b><span>{objectRowSub(o, C.kind[o.kind])}</span></span>
          <span className={cx(s.rowEnd, s.mono)}>{approx ? C.noCoords : distanceM != null ? fmtDistance(distanceM) : ''}</span>
        </button>
      ))}
    </div>
  )
  return (
    <div className={inSheet ? s.resultsIn : s.results} role="listbox" aria-label={C.searchObjects}>
      <div className={s.grp}>{C.searchObjects}</div>
      {!q ? (
        <>
          {nearest.length > 0 && objectRows(nearest)}
          <div className={s.quiet}>{C.searchHint}</div>
        </>
      ) : hits.length ? objectRows(hits) : (
        <div className={s.quiet}>{C.searchNoObject}</div>
      )}
      {q && (
        <>
          <div className={s.grp}>{C.searchAddresses}</div>
          {addrState === 'offline' ? <div className={s.note}><Icon id="info" /><span>{C.searchOffline}</span></div>
            : addrState === 'error' ? <div className={s.note}><Icon id="warn" /><span>{C.searchFailed}</span></div>
              : addrState === 'short' ? <div className={s.quiet}>{C.searchMinChars}</div>
                : addrState === 'loading' && !addresses.length ? <div className={s.skeleton} />
                  : addresses.length ? (
                    <div className={s.list}>
                      {addresses.map((a, i) => {
                        const [street, place] = splitAddress(a.label)
                        return (
                          <button key={`${a.label}:${i}`} type="button" role="option" aria-selected={false} className={s.row} onClick={() => onPickAddress(a)}>
                            <span className={s.rowLead}><Icon id="pin" /></span>
                            <span className={s.rowText}><b>{street}</b><span>{[place, C.addressKind].filter(Boolean).join(' · ')}</span></span>
                            <Icon id="chevron" className={s.chev} />
                          </button>
                        )
                      })}
                    </div>
                  ) : addrState === 'ok' ? <div className={s.quiet}>{C.searchNoAddress}</div> : null}
        </>
      )}
      <div className={s.quiet}>{C.searchFoot}</div>
    </div>
  )
}
