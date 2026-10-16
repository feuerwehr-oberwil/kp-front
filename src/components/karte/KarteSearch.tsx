// «Karte & Objekte» — the search results under the bar: station objects first (found on the
// device, offline too — lib/karte/search), then addresses from the geocoder (online only).
// An empty query offers the Einsatzobjekte, which is what a member opening the search looks for.

import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { fillTemplate } from '../../lib/format'
import { fmtDistance } from '../../lib/geo'
import type { GeoHit } from '../../lib/api/geo'
import type { StationObject } from '../../lib/api/stationReference'
import { openableCount, type ObjectHit } from '../../lib/karte/search'
import { splitAddress } from '../../lib/karte/places'
import { KeyBoxGlyph } from './KeyBoxGlyph'
import s from './Karte.module.css'

export type AddrState = 'idle' | 'short' | 'loading' | 'ok' | 'offline' | 'error'

export function KarteSearch({ query, hits, featured, addresses, addrState, onPickObject, onPickAddress }: {
  query: string
  hits: ObjectHit[]
  /** shown while nothing is typed */
  featured: StationObject[]
  addresses: GeoHit[]
  addrState: AddrState
  onPickObject: (id: string) => void
  onPickAddress: (hit: GeoHit) => void
}) {
  const C = appConfig.copy.karte
  const q = query.trim()
  const plans = (o: StationObject) => {
    const n = openableCount(o)
    return n === 0 ? <span>{C.plansNone}</span> : <span className={s.plansCount}>{n === 1 ? C.plansOne : fillTemplate(C.plansMany, { n })}</span>
  }
  const lead = (o: StationObject) => <span className={s.rowLead}>{o.kind === 'depot' ? <KeyBoxGlyph /> : <Icon id="footprint" />}</span>
  return (
    <div className={s.results} role="listbox" aria-label={C.searchObjects}>
      <div className={s.grp}>{C.searchObjects}</div>
      {!q ? (
        <>
          {featured.length > 0 && (
            <div className={s.list}>
              {featured.map((o) => (
                <button key={o.id} type="button" role="option" aria-selected={false} className={s.row} onClick={() => onPickObject(o.id)}>
                  {lead(o)}
                  <span className={s.rowText}><b>{o.name}</b><span>{o.address ?? C.kind[o.kind]}</span></span>
                  <span className={s.rowEnd}>{plans(o)}<Icon id="chevron" className={s.chev} /></span>
                </button>
              ))}
            </div>
          )}
          <div className={s.quiet}>{C.searchHint}</div>
        </>
      ) : hits.length ? (
        <div className={s.list}>
          {hits.map(({ obj: o, distanceM, approx }) => (
            <button key={o.id} type="button" role="option" aria-selected={false} className={s.row} onClick={() => onPickObject(o.id)}>
              {lead(o)}
              <span className={s.rowText}><b>{o.name}</b><span>{[o.address, C.kind[o.kind]].filter(Boolean).join(' · ')}</span></span>
              <span className={`${s.rowEnd} ${s.stack}`}>
                <span className={s.mono}>{approx ? C.noCoords : distanceM != null ? fmtDistance(distanceM) : ''}</span>
                {plans(o)}
              </span>
            </button>
          ))}
        </div>
      ) : (
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
