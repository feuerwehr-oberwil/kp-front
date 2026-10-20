// «Karte & Objekte» — Gefahrgut as a tool of its own: a UN number looked up WITHOUT placing a
// Gefahrentafel. The readout is the Gefahrentafel's own (UnHazardSection: ADR, Kemler, ERG,
// source), and its rings are temporary map overlays that die with this card — nothing is placed,
// nothing is stored (lib/karte/session). Offline: the ADR/ERG tables are on the device.
//
// On a PHONE it is a slide-up like Ebenen (owner, review round 3: «just another slide-up»,
// KarteKeySheet): the UN field is its first line, the readout scrolls under it; with the keyboard up
// the sheet stands on the keys, and after ✓ it drops back with the result and the rings above it.
// The field is one iOS must not take for a contact form (lib/typingField) and is focused without
// letting Safari move the page (lib/iosKeyboard · noPanTouchEnd).

import { useLayoutEffect, useRef } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import type { ErgRingMode } from '../../lib/ergRings'
import { lookupErg } from '../../lib/erg'
import { UnHazardSection } from '../UnHazardSection'
import { SearchField } from '../SearchField'
import { defuseAutofill, typingFieldProps } from '../../lib/typingField'
import { focusWithoutPan, noPanTouchEnd } from '../../lib/iosKeyboard'
import type { LngLat } from '../../types'
import { KarteKeySheet } from './KarteKeySheet'
import s from './Karte.module.css'

export function KarteGefahrgut({ un, onUn, mode, onMode, center, onClose, phone = false, focusOnOpen = false }: {
  un: string
  onUn: (v: string) => void
  mode: ErgRingMode
  onMode: (m: ErgRingMode) => void
  /** where the rings stand — null until the map is tapped (or a place is selected) */
  center: LngLat | null
  onClose: () => void
  /** the phone's slide-up instead of the tablet's card */
  phone?: boolean
  /** opened by a tap with no number yet: the caret in the field at once, the number pad up —
   *  focused without letting Safari move the page (lib/iosKeyboard · focusWithoutPan) */
  focusOnOpen?: boolean
}) {
  const C = appConfig.copy.karte
  const fieldRef = useRef<HTMLInputElement>(null)
  // on mount only: a sheet already open never grabs the caret back
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (phone && focusOnOpen) focusWithoutPan(fieldRef.current) }, [])
  const digits = (v: string) => onUn(v.replace(/\D/g, '').slice(0, 4))
  const body = (
    <>
      {!un && <div className={s.src}>{C.ergOffline}</div>}
      {/* «Auf die Karte tippen …» first, where the eye is after typing — under the readout it was
          below the fold of the phone's card (review round 2), the one line that says the rings
          can be moved */}
      {un && mode !== 'off' && !!lookupErg(un)?.tih?.length && <div className={s.toolHint}><Icon id="pin" /><span>{center ? C.ergCenter : C.ergCenterFirst}</span></div>}
      {un && (
        <UnHazardSection un={un} ringMode={mode} onRingMode={onMode} ergCoord={center ?? undefined} nameRow />
      )}
    </>
  )
  if (phone) {
    return (
      <KarteKeySheet
        label={C.tools.erg}
        onClose={onClose}
        field={(
          <SearchField
            {...typingFieldProps('number', 'karte-un')}
            ref={fieldRef} id="karte-un" className={s.keyField} icon="warn" noClear maxLength={4}
            placeholder={defuseAutofill(C.ergUnLong)} aria-label={defuseAutofill(C.ergUn)}
            value={un} onChange={digits} onTouchEnd={noPanTouchEnd}
          />
        )}
      >
        {body}
      </KarteKeySheet>
    )
  }
  return (
    <section className={cx('layers-card', s.toolCard)} aria-label={C.tools.erg}>
      <div className="lc-title">
        {C.tools.erg}
        <button type="button" className="ip-x lc-x" aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
      </div>
      {/* the field stays put above the readout, outside its scroller: typing never scrolls it away,
          and with the keyboard up the card stands on the keys with the field at its top */}
      <div className={s.toolField}>
        <label className={s.fieldLabel} htmlFor="karte-un">{defuseAutofill(C.ergUn)}</label>
        <input
          {...typingFieldProps('number', 'karte-un')}
          id="karte-un" className={cx('ip-input', s.unField)} maxLength={4}
          placeholder={C.ergPlaceholder} value={un} onChange={(e) => digits(e.target.value)}
        />
      </div>
      <div className="lc-body">{body}</div>
    </section>
  )
}
