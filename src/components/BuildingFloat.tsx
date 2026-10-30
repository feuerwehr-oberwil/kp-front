import { useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChipSummary } from '../lib/buildingCard'
import { useOnlyOpenCard } from '../lib/floatCards'
import { BuildingCard } from './BuildingCard'
import s from './BuildingFloat.module.css'

/**
 * The Gebäude-Steckbrief ON the surface (owner, 09.10.2026: «on the map directly, not in the
 * dropdown»): one chip of the floating family in the bottom-left chip row — the Karte's own row,
 * and the plan's row beside the Objekt chip — that opens the card docked one row above it.
 *
 * ⚠️ In the ROW, not pinned to the building on the map. A geo-anchored chip lies exactly where the
 * Lage is drawn (Brandherd, Fahrzeuge, the first Trupp all stand at the Einsatzort), moves with every
 * pan, and has no plan-side twin. The row never covers a symbol, it is the same place on both
 * surfaces (Lage ↔ Plan), and the floating row already budgets for it (15-mobile · --float-row,
 * the message lane stands above it). The card is non-modal like the Passung beside it: the map
 * stays pannable, ✕ or the chip closes it.
 *
 * Closed, the chip says what a crew must not miss: the hazards as glyph + WORD («⚠ Gas · PV»), else
 * just «Gebäude-Info» (not «Gebäude» + the storey glyph: that is the rail's Gebäude tile, a
 * surface of its own). Nothing to say → no chip (lib/buildingCard · hasBuildingContent).
 *
 * The FIRST time this device shows the Karte of an Einsatz whose building has anything to show,
 * the card opens by itself (`autoOpen`, lib/buildingFirstOpen —
 * the workspace decides when); closing it marks it read (`onRead`). The plan's row never passes it.
 */
export function BuildingFloat({ info, compact = false, autoOpen = false, onRead }: {
  info: BuildingInfo | null
  compact?: boolean
  /** the card's FIRST open on this device (lib/buildingFirstOpen): it opens by itself while this
   *  is true — still non-modal, the map stays live — and stays as the operator leaves it */
  autoOpen?: boolean
  /** the card was closed (✕, Esc, the chip): it has been read */
  onRead?: () => void
}) {
  const [open, setOpen] = useState(autoOpen)
  // React's «adjust state while rendering»: the moment `autoOpen` turns on, the card opens
  const [auto, setAuto] = useState(autoOpen)
  if (autoOpen !== auto) { setAuto(autoOpen); if (autoOpen) setOpen(true) }
  const summary = buildingChipSummary(info)
  const read = useRef(onRead)
  useEffect(() => { read.current = onRead })
  const close = useCallback(() => { setOpen(false); read.current?.() }, [])
  // one card of the chip row at a time: another opening closes this one (lib/floatCards)
  useOnlyOpenCard(open, close)
  // Esc closes it, like every other floating card
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])
  if (!summary) return null
  const C = appConfig.copy.building
  // compact (a phone, where the floating row is one line beside the FAB, and the plan's row, where
  // it is the Objekt chip's second half): the hazard words only; without hazards the glyph alone,
  // its words in aria-label/title like the row's lamped chips
  const text = summary.hazard
    ? (compact ? summary.words.join(' · ') : `${C.chipTitle} · ${summary.words.join(' · ')}`)
    : (compact ? null : C.chipTitle)
  return (
    <span className={s.anchor}>
      <button
        type="button"
        // the floating family's own chip (`.wb-scale-chip`) — the module only adds the hazard tone;
        // it never had a `.chip` of its own, and reading one printed «undefined» into the class
        className={cx('wb-scale-chip', open && 'arm', summary.hazard && s.hazard)}
        aria-label={summary.label}
        title={summary.label}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon id={summary.hazard ? 'warn' : 'info'} />
        {text && <span>{text}</span>}
        {/* the Objekt's Sofortmassnahmen are inside — a word on a tablet, the glyph alone on a phone */}
        {summary.measures && <span className={s.measures}><Icon id="checklist" />{!compact && C.measuresShort}</span>}
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label={C.title}>
          <BuildingCard info={info} onClose={close} />
        </div>
      )}
    </span>
  )
}
