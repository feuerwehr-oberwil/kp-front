import { useMemo, useRef, useState } from 'react'
import Map, { type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../lib/maplibreWorker'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { deploymentDefaultCenter } from '../lib/deploymentConfig'
import { usePickAddress } from '../lib/mapPickAddress'
import { Overlay, SheetFoot } from '../lib/overlays'
import { pickerBaseStyle } from '../lib/pickerBaseStyle'
import { useNightTheme } from '../lib/useNightTheme'
import { useOnline } from '../lib/useOnline'
import type { LngLat } from '../types'
import { Button, IconButton } from './Button'
import { QuietAttributionControl } from './MapAttribution'

// «Standort auf Karte setzen» – the intake wizard's location picker (EinsatzWizard · «Auf Karte»).
// It works with NO active incident: the workspace map does not exist yet on a fresh Einsatz.
//
// FULL SCREEN with the pin fixed in the middle (owner, sweep 30.10.2026 #5, mock 5A: «definitely A
// as full screen, but move the information for the map down to the bottom right entirely so it's
// out of the way»). It was a sheet over the wizard's sheet with a pin to tap first, then drag, and
// a hint bubble on the map. Now:
//   · the map moves under the pin and the map CENTRE is the pick, so «Standort übernehmen» is live
//     from the first frame and there is nothing to explain – no hint;
//   · one way back, the ‹ in the head (and Escape), to the form as it was – no «Abbrechen»;
//   · under the pin, live, the address the centre would bring into an empty «Adresse» field
//     (lib/mapPickAddress – the same lookup the wizard runs after «übernehmen»), its coordinates
//     offline;
//   · the map's attribution is a closed ⓘ in its bottom-right corner (MapAttribution);
//   · the Lagekarte's own base, dark at night (lib/pickerBaseStyle, PlanPicker's too) with the
//     Lagekarte's own street names over it – the dark tiles' baked ones were tiny and few – one
//     zoom step closer than the old sheet opened.
// The same frame on a tablet: full screen inside its overlay.
const COUNTRY_CENTER: LngLat = [8.2275, 46.8182] // last-resort fallback: Switzerland centroid

export function MapPicker({ initial, onCancel, onConfirm }: {
  /** current resolved coord, if any, to center on ([lng, lat]) */
  initial: LngLat | null
  onCancel: () => void
  onConfirm: (c: LngLat) => void
}) {
  const night = useNightTheme()
  const online = useOnline()
  const style = useMemo(() => pickerBaseStyle(night, { vectorNames: true }), [night])
  const mapRef = useRef<MapRef>(null)
  // No resolved coord yet → open on the station's own area (deployment centre), not a
  // country-wide view that drops the EL in the middle of nowhere.
  const station = deploymentDefaultCenter()
  const start = initial ?? station ?? COUNTRY_CENTER
  // the centre the map RESTS on (null while it moves): what the line under the pin is about
  const [rest, setRest] = useState<LngLat | null>(start)
  const line = usePickAddress(rest, online)
  const mp = appConfig.copy.mapPicker
  const centre = (): LngLat => {
    const c = mapRef.current?.getCenter()
    return c ? [c.lng, c.lat] : rest ?? start
  }
  return (
    // no swipe-to-close: every drag on this frame is the map's
    <Overlay open onClose={onCancel} className="mp-sheet ui-dialog" backdropClassName="mp-backdrop" ariaLabel={mp.title} swipeToClose={false}>
      <div className="mp-head">
        <IconButton label={mp.back} variant="secondary" onClick={onCancel}><Icon id="chevron-left" /></IconButton>
        <span className="mp-title">{mp.title}</span>
      </div>
      <div className="mp-map">
        <Map
          ref={mapRef}
          initialViewState={{ longitude: start[0], latitude: start[1], zoom: initial ? 17 : station ? 15.5 : 8 }}
          mapStyle={style}
          attributionControl={false}
          dragRotate={false}
          onMoveStart={() => setRest(null)}
          onMoveEnd={(e) => { const c = e.target.getCenter(); setRest([c.lng, c.lat]) }}
        >
          <QuietAttributionControl />
        </Map>
        {/* the pin stands still, the map moves under it: its dot IS the map's centre */}
        <div className="mp-pin" aria-hidden><Icon id="flag" /><span className="mp-pin-dot" /></div>
        <div className={cx('mp-addr', line.kind === 'looking' && 'is-looking')} role="status">
          {line.kind === 'looking' ? mp.looking : line.text}
        </div>
      </div>
      <SheetFoot className="mp-act">
        <Button variant="primary" size="lg" block icon={<Icon id="flag" />} onClick={() => onConfirm(centre())}>{mp.confirm}</Button>
      </SheetFoot>
    </Overlay>
  )
}
