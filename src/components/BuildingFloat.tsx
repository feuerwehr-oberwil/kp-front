import { useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChipSummary } from '../lib/buildingCard'
import { useOnlyOpenCard } from '../lib/floatCards'
import { useLayer } from '../lib/overlays/layer'
import { useIsPhone } from '../lib/useIsPhone'
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
 * the message lane stands above it). The card is non-modal: no scrim, nothing trapped. ✕, the
 * chip, Esc, the native back and a tap beside it close it – that tap ONLY closes it, it never pans,
 * selects or places on the map under it (lib/overlays/layer, owner call 2, 17.11.2026).
 *
 * Closed, the chip says what it is and what a crew must not miss: «Gebäude-Info», then the hazards
 * as glyph + WORD («⚠ Gebäude-Info · Gas · PV») on a tablet (owner pick C8, 05.11.2026: «always
 * Gebäude-Info when it's about the info»). OPEN, it is lit like a pressed tile, with ⌄ (owner pick M4 B,
 * 18.11.2026) – the chip toggles the card, and now looks it. Not «Gebäude» + the storey glyph: that is the rail's
 * Gebäude tile, a surface of its own. Nothing to say → no chip (lib/buildingCard · hasBuildingContent).
 *
 * ⚠️ On a PHONE it is a TILE, always (button round 17.11.2026, owner pick 12C + follow-up «the whole
 * phone floating row = tiles»; 09-whiteboard · .wb-tile): the 22px glyph over its 11/700 word, the
 * family's height, like the Eintrag FAB and the building / Objekt tile it shares a glass with. The
 * word is «Info» – the building tile beside it already says «Gebäude» or the street – or, with a
 * hazard, the hazard words in the hazard tone under the ⚠ («⚠ Heizöl»). The SHAPE never flips with
 * the content any more (12A / 16.11. switched chip ↔ tile on a hazard); a long hazard list
 * ellipsises inside the capped tile, and `aria-label` / `title` keep the full sentence.
 *
 * ⚠️ ONE action, so one glyph and one label (owner, 09.11.2026 – mock nov09-gebaeude-sofort, «do not
 * split»): the Objekt's Sofortmassnahmen are a count badge on the chip («Gebäude-Info ②»), the way
 * every count in the app is shown – no second glyph and word behind a divider, which read as a
 * second button. The same on a tablet, a phone and the plan's row; the label spells it out.
 *
 * The FIRST time this device shows the Karte of an Einsatz whose building has anything to show,
 * the card opens by itself (`autoOpen`, lib/buildingFirstOpen —
 * the workspace decides when); closing it marks it read (`onRead`). The plan's row never passes it.
 */
export function BuildingFloat({ info, autoOpen = false, onRead }: {
  info: BuildingInfo | null
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
  const phone = useIsPhone()
  const read = useRef(onRead)
  useEffect(() => { read.current = onRead })
  const close = useCallback(() => { setOpen(false); read.current?.() }, [])
  // one card of the chip row at a time: another opening closes this one (lib/floatCards)
  useOnlyOpenCard(open, close)
  // the way out is every layer's (lib/overlays/layer, 17.11.2026): a tap beside the card only
  // closes it (it did nothing), Esc closes it ALONE – it used to also drop the Lage's selection or
  // put the Plan's placement down with the same press – the native back closes it, and focus goes
  // back to the chip
  const anchor = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useLayer({ open, onClose: close, inside: [anchor], returnFocus: chip })
  if (!summary) return null
  const C = appConfig.copy.building
  return (
    <span className={s.anchor} ref={anchor}>
      <button
        ref={chip}
        type="button"
        // the floating family's own chip (`.wb-scale-chip`), a tile on a phone (`.wb-tile`) — the
        // module only adds the hazard tone and the count badge
        className={cx('wb-scale-chip wb-tile', open && 'arm', summary.hazard && s.hazard)}
        aria-label={summary.label}
        title={summary.label}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon id={summary.hazard ? 'warn' : 'info'} />
        {/* a KNOWN hazard is the words after the dot, in the hazard tone (hill climb r15, Opus 5):
            in ink the chip read as one more neutral control. The plate stays neutral – no fill,
            this is a fact to read, not an alarm. */}
        <span>{phone
          ? summary.hazard ? <b className={s.words}>{summary.words.join(' · ')}</b> : C.chipTitleShort
          : <>{C.chipTitle}{summary.hazard && <> · <b className={s.words}>{summary.words.join(' · ')}</b></>}</>}</span>
        {/* the Objekt's Sofortmassnahmen are inside: their count, in the one count-badge idiom –
            while the card is open it shows them, and the corner is the ⌄'s */}
        {summary.measures > 0 && !open && <span className={s.count} aria-hidden>{summary.measures}</span>}
        {/* open = LIT (09-whiteboard · .wb-scale-chip.arm) with ⌄ «tap again to fold it» (round
            18.11.2026, owner pick M4 B): the 14 % blue wash it wore read as «still standing there» */}
        {open && <Icon id="chevron-down" className="wb-chip-chev" />}
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label={C.title}>
          <BuildingCard info={info} onClose={close} />
        </div>
      )}
    </span>
  )
}
