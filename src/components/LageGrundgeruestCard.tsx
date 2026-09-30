import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { fillTemplate } from '../lib/format'
import { categoryShort, placeable, suggestionText, takeOverKind, type GrundgeruestRow } from '../lib/lageGrundgeruest'

interface Props {
  rows: GrundgeruestRow[]
  progress: { done: number; total: number; complete: boolean }
  /** the Einsatzart whose list this is (lib/lageGrundgeruest · slotsFor) — the head's word */
  category: string
  /** the incident has no location of its own — no suggestions, and the card says why */
  noLocation?: boolean
  /** the row whose place tool is armed right now (its next Karte tap places it) */
  armedSlotId: string | null
  phone: boolean
  /** PHONE: open on arrival (the card was asked for from the «+» sheet) */
  startOpen?: boolean
  onArm: (row: GrundgeruestRow) => void
  onPlace: (row: GrundgeruestRow) => void
  onToKarte: (row: GrundgeruestRow) => void
}

/**
 * The Lage-Grundgerüst on the Karte (lib/lageGrundgeruest): «Grundgerüst Brand 2/6», one row
 * per slot. A done row is ticked; an open row is «+ label» — a tap arms the ordinary place tool, so
 * the next Karte tap places it — and, where the data has one, a suggestion line whose «Setzen»
 * places the symbol THERE (an ordinary placement: undoable, its usual Verlauf row). A suggestion
 * is only ever a starting point to drag.
 *
 * The head NAMES the Einsatzart whose list this is, as a plain word — it changes nothing (30.09.2026,
 * owner: «drop the grundgerüst change in type»). It was a chip that opened the Einsatzdaten (slim
 * sweep 27.09.2026) and asked «Einsatzart?» in amber while none was known: a second door to the
 * type on a card whose job is placing. The Einsatzart is set where it always was, in the
 * Einsatzdaten. Unknown, the Brand list stands in and the word says «Brand» — the list it is.
 *
 * Tablet: a small floating card, bottom-left of the Karte. Phone: the same list as a collapsible
 * strip above the tool bar — collapsed it is one pill with the count, so it never covers the
 * phone's two bars, and the host hides it while a tool dock or the selection bar needs that lane.
 * The head's ⌄ is the strip's one fold; the «ausblenden» row it had at its foot said the same
 * thing a second time and cost 44px (27.09.2026). The tablet's «ausblenden» went the same way
 * (29.09.2026): the rail's «Grundgerüst» tile is the card's one toggle.
 */
export function LageGrundgeruestCard({ rows, progress, category, noLocation, armedSlotId, phone, startOpen, onArm, onPlace, onToKarte }: Props) {
  const C = appConfig.copy.lageGrundgeruest
  // phone only: the strip starts as one pill — a list over half a 360px Karte is the thing a
  // 3am operator did not ask for, and the pill's count is already the prompt
  const [open, setOpen] = useState(!!startOpen)
  const count = progress.total > 0 ? fillTemplate(C.count, { done: progress.done, total: progress.total }) : null
  const body = !phone || open
  // which list this is, said and nothing more — no door, no chevron (see the doc comment)
  const art = <span className="lgg-art">{categoryShort(category)}</span>

  return (
    <section
      className={`lgg${phone ? ' lgg-phone' : ''}${phone && !open ? ' lgg-folded' : ''}${progress.complete ? ' lgg-complete' : ''}`}
      aria-label={C.title}
    >
      {/* PHONE: the whole head folds — the toggle button is its accessible half (icon + word); the
          Einsatzart word, the count and ⌄ let the tap through to the head. One toggle, not a
          button wrapped around a button. */}
      <header className={`lgg-head${phone ? ' lgg-head-fold' : ''}`} onClick={phone ? () => setOpen((o) => !o) : undefined}>
        {phone ? (
          <button type="button" className="lgg-toggle" aria-expanded={open} aria-label={open ? C.collapse : C.expand}>
            <Icon id="grundgeruest" className="lgg-ic" />
            <span className="lgg-title">{C.short}</span>
            {art}
          </button>
        ) : (
          <span className="lgg-heading">
            <Icon id="grundgeruest" className="lgg-ic" />
            <span className="lgg-title">{C.short}</span>
            {art}
          </span>
        )}
        {count && <span className="lgg-count">{count}</span>}
        {/* no «ausblenden» on the tablet either (29.09.2026, sweep K7): the lit rail tile beside
            the card toggles it, and the word cost the card its own name («Gru…») */}
        {phone && <Icon id="chevron-down" className="lgg-chev" />}
      </header>
      {body && (
        <>
          {noLocation && rows.some((r) => !r.match.done && r.slot.vorschlag) && <p className="lgg-note">{C.noLocation}</p>}
          {rows.length === 0 && <p className="lgg-note">{C.empty}</p>}
          {progress.complete && <p className="lgg-note lgg-done-note">{C.complete}</p>}
          <ul className="lgg-list">
            {rows.map((row) => {
              const { slot, match, suggestion } = row
              const armed = armedSlotId === slot.id
              if (match.done) {
                return (
                  <li key={slot.id} className={`lgg-row done${armed ? ' armed' : ''}`}>
                    <span className="lgg-line">
                      <Icon id="check" className="lgg-tick" />
                      <span className="lgg-label">{slot.label}</span>
                    </span>
                    {takeOverKind(match.onPlan) && (
                      // ticked by an object ANCHORED on a plan — the 23.09.2026 Sammelplatz on the
                      // building plan. It counts; taking it over moves that same record onto the
                      // Karte (in place, or at the next Karte tap when its sheet has no fit).
                      <button type="button" className="lgg-sug" aria-pressed={armed} onClick={() => onToKarte(row)}>
                        <span className="lgg-sug-t">{C.planOnly}</span>
                        {/* armed, the slot says what the next tap does — a hint, not the tile */}
                        {armed ? <span className="lgg-sug-armed">{C.armed}</span> : <span className="lgg-sug-act">{C.toKarte}</span>}
                      </button>
                    )}
                  </li>
                )
              }
              return (
                <li key={slot.id} className={`lgg-row${armed ? ' armed' : ''}`}>
                  <button type="button" className="lgg-add" aria-pressed={armed} onClick={() => onArm(row)}>
                    <Icon id="plus" className="lgg-plus" />
                    <span className="lgg-label">{slot.label}</span>
                    {slot.optional && <span className="lgg-opt">{C.optional}</span>}
                    {armed && <span className="lgg-armed">{slot.linie ? C.armedLine : C.armed}</span>}
                  </button>
                  {placeable(suggestion) && (
                    <button type="button" className="lgg-sug" onClick={() => onPlace(row)}>
                      <span className="lgg-sug-t">{suggestionText(suggestion)}</span>
                      <span className="lgg-sug-act">{C.placeHere}</span>
                    </button>
                  )}
                  {/* said, never placeable: no hydrant close enough to be an answer */}
                  {suggestion && !placeable(suggestion) && (
                    <p className="lgg-sug lgg-sug-info"><span className="lgg-sug-t">{suggestionText(suggestion)}</span></p>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
