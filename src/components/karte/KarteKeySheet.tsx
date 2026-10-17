// «Karte & Objekte» on a PHONE — the slide-up sheet a field lives in: the search and Gefahrgut
// (owner, review round 3, 17.10.2026: «just another slide-up», the same as Ebenen). The frame IS
// Ebenen's (`.layers-card`: flush with the bottom edge and both sides, over the bar, hugging its
// content up to the cap, pushed down to close); its FIRST line is the field with the ✕ beside it,
// and what the field finds scrolls under it.
//
// With the keyboard up the sheet keeps that height but stands ON the keyboard's top edge, never
// taller than the room under the top bar less a strip of map (lib/iosKeyboard · useKeySheet →
// `data-kb`, `--ks-bottom`, `--ks-max`); the field stays the sheet's top line, so it is always in
// sight and iOS has no reason to move the page. When the keyboard goes (✓ or a tap elsewhere) the
// sheet drops back to its normal place with the result, until a pick or the ✕.
//
// ONLY THE BODY SCROLLS (owner, review round 4, 17.10.2026: «scrolling in the main search bar is
// rather ugly and moves everything. ensure it only scrolls the listed objects»): the grab bar and
// the field line are the sheet's handle, the body is the list's alone — a drag over it never
// pulls the sheet (useSwipeDismiss · headOnly), it never bounces or hands its scroll on to the
// page (Karte.module.css · .keyBody), and the search sheet (`fill`) stands at its full height from
// the start, so a growing or shrinking result list never moves the field.

import { useRef, type ReactNode } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { useKeySheet } from '../../lib/iosKeyboard'
import { SheetGrab, useSwipeDismiss } from '../../lib/overlays'
import s from './Karte.module.css'

export function KarteKeySheet({ label, field, onClose, children, className, fill = false }: {
  /** what the sheet is (aria-label — it has no title row: the field is its first line) */
  label: string
  /** the first line: the field */
  field: ReactNode
  onClose: () => void
  children?: ReactNode
  className?: string
  /** the sheet's full height from the start, whatever the body holds (the search's result list) */
  fill?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  useKeySheet(ref)
  const swipe = useSwipeDismiss({ onClose, headOnly: true })
  return (
    <section ref={ref} className={cx('layers-card', s.sheet, s.keySheet, fill && s.fill, className)} aria-label={label} data-karte-keysheet="" {...swipe}>
      <SheetGrab />
      <div className={s.keyLine} data-sheet-head="">
        {field}
        <button type="button" className="ip-x lc-x" aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
      </div>
      {children != null && <div className={cx('lc-body', s.keyBody)}>{children}</div>}
    </section>
  )
}
