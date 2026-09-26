import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import type { SuchePin } from '../../lib/suche'
import s from './Suche.module.css'

/**
 * A place (or a person without one) where somebody put it — the Suche on the surface itself
 * (26.09.2026, the owner's answer on the overlay: «like E4, but easier»). The app's chip look,
 * 12.5px words: the status in the colour of the list's circle (grey offen, blue in Arbeit with
 * its Trupp, green + ✓ abgesucht, half for teilweise, amber nicht zugänglich), and a RED ring while
 * somebody is still missing there. A stem points at the spot. A tap opens the card on the record.
 */
export function SuchePinChip({ pin, onOpen }: { pin: SuchePin; onOpen?: (pin: SuchePin) => void }) {
  const C = appConfig.copy.suche
  const status = pin.kind === 'person' ? C.status.vermisst : C.bereichStatus[pin.status as keyof typeof C.bereichStatus]
  return (
    <button type="button" className={s.pin} data-status={pin.status} data-hot={pin.hot || undefined} data-kind={pin.kind}
      aria-label={`${C.title}: ${pin.label} · ${status}`} title={`${pin.label} · ${status}`}
      // the pin is the surface's, not the surface's tap: a press here must never also reach the
      // map or the plan underneath (a tap there would place, select or close something)
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen?.(pin) }}>
      <span className={s.pinDot} aria-hidden>
        {pin.kind === 'person' ? <Icon id="people" /> : pin.status === 'abgesucht' ? <Icon id="check" /> : null}
      </span>
      <span className={s.pinText}>{pin.label}</span>
    </button>
  )
}

/** The Karte's pins — HTML markers after the tactical symbols, so they stand on top of them. */
export function SucheMapPins({ pins, onOpen }: { pins: readonly SuchePin[]; onOpen?: (pin: SuchePin) => void }) {
  return (
    <>
      {pins.filter((p) => p.point.coord).map((p) => (
        <Marker key={`suche:${p.id}`} longitude={p.point.coord![0]} latitude={p.point.coord![1]} anchor="bottom"
          style={{ zIndex: 5, pointerEvents: onOpen ? undefined : 'none' }}>
          <SuchePinChip pin={p} onOpen={onOpen} />
        </Marker>
      ))}
    </>
  )
}
