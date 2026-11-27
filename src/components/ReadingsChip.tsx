import { useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { Icon } from '../lib/icons'
import { useOnlyOpenCard } from '../lib/floatCards'
import { useLayer } from '../lib/overlays/layer'
import { useRailLabels } from '../lib/useDevicePrefs'
import { useMinuteClock } from '../lib/minuteClock'
import { worstFirst, type MeasuredPoint } from '../lib/readingsList'
import { ReadingPill } from '../lib/symbolRender'
import { ListCard, ListRow } from './ListRow'
import s from './ReadingsChip.module.css'

/**
 * «Messungen» in the floating chip row – the Karte's and every plan's (owner, 27.10.2026). The chip
 * is the worst reading's pill in its alarm colour, the icon alone (owner pick 9A, 28.10.2026: the
 * value is one tap away, in the list) – beside «Messungen» on a tablet, over it on a phone, where
 * the whole floating row is tiles (button round 17.11.2026, owner pick 12C · 09-whiteboard ·
 * .wb-tile; it was the bare pill in a 52px square until then); a tap opens
 * EVERY Messpunkt of the Einsatz as one list, worst first, the
 * place as a tag (pick L2: no groups). A row goes to its point – the sheet it was placed on, else
 * the Karte – and closes the list. Non-modal like the Gebäude-Info beside it: Esc, the chip, a tap
 * beside it or the native back close it (lib/overlays/layer).
 * Rendered only once a Messpunkt exists (`points` non-empty). With «Beschriftung der
 * Werkzeugleisten» off the word goes, as the bars' words do (owner, Üben feedback 27.11.2026).
 */
export function ReadingsChip({ points, compact = false, onGo }: {
  points: MeasuredPoint[]
  /** a phone: the tile – the pill over the word (09-whiteboard · .wb-tile) */
  compact?: boolean
  onGo: (p: MeasuredPoint) => void
}) {
  const [open, setOpen] = useState(false)
  // «Beschriftung … Aus»: the pill alone, no «Messungen» (TopBar · `worded`, owner 27.11.2026)
  const worded = useRailLabels() === 'short'
  // one chip-row card at a time: opening this list closes the Gebäude card, and vice versa
  useOnlyOpenCard(open, () => setOpen(false))
  // the way out is the Gebäude card's, every layer's (lib/overlays/layer): a tap beside it only
  // closes it, Esc closes it alone, the native back closes it, focus goes back to the chip
  const anchor = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useLayer({ open, onClose: () => setOpen(false), inside: [anchor], returnFocus: chip })
  // re-sorted on the minute clock the pills age by, so the chip's pill stays the list's first row
  // when a reading turns stale (measuredPoints sorted them when the Einsatz last changed)
  const now = useMinuteClock()
  const sorted = useMemo(() => worstFirst(points, now), [points, now])
  const worst = sorted[0]
  if (!worst) return null
  const C = appConfig.copy.building
  return (
    <span className={s.anchor} ref={anchor}>
      <button ref={chip} type="button" className={cx('wb-scale-chip wb-tile', open && 'arm', !worded && 'wb-chip-bare')} aria-expanded={open}
        title={C.readingsChipLabel} aria-label={C.readingsChipLabel} onClick={() => setOpen(!open)}>
        {/* the glyph leads a tile (the pill over the word), the word leads a chip */}
        {compact
          ? <><ReadingPill props={worst.props} inline bare />{worded && <span>{C.readingsChip}</span>}</>
          : <>{worded && <span>{C.readingsChip}</span>}<ReadingPill props={worst.props} inline bare /></>}
        {/* open = lit with ⌄, the Gebäude chip's twin beside it (BuildingFloat, owner pick M4 B);
            bare (words off) the lit fill alone says it – a ⌄ would be a second glyph */}
        {open && worded && <Icon id="chevron-down" className="wb-chip-chev" />}
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label={C.readingsChip}>
          {/* ONE Messpunkt row (ListRow, LISTS.8): the pill LEADS – the value is the mark – then
              the Raum, where it is as a tag, and › because the tap goes to the point. The same
              row as the Gebäude's storey list (ReadingParts · StackReadings). */}
          <ListCard look="rail">
            {sorted.map((p) => (
              <ListRow key={p.id} onClick={() => { setOpen(false); onGo(p) }}
                lead={<ReadingPill props={p.props} inline />}
                title={p.props.fields?.Raum?.trim() || p.props.label || ''}
                end={<span className={s.where}>{p.where}</span>} />
            ))}
          </ListCard>
        </div>
      )}
    </span>
  )
}
