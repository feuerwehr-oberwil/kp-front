import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { meldungTap, rankMeldungen, type Meldung } from '../lib/meldungen'
import { getMeldungen, subscribeMeldungen } from '../lib/useMeldung'

// ══ Die Meldeleiste ══════════════════════════════════════════════════════════════════════
// ONE strip under the top bar, spanned between the two rails, for every message that has no
// place of its own and stays until somebody acts. It replaces five floating banners anchored 4px
// apart on one axis with no stacking rule, four bottom cards sharing one coordinate, five
// z-indexes and four simultaneous role="alert" regions.
//
// Two things it deliberately does NOT do:
//  · it does not exist when nothing is pending — `null`, not an empty 52px band. A strip that
//    costs height on a quiet Einsatz is a bad trade, and that is the property that won it the
//    argument against a badge on the nav rail (0px always, but a digit where the 3am rule wants
//    a sentence).
//  · the queue does not PAGE, and it does not PROMOTE. Paging hides the message you are reading;
//    promotion (what tapping a queued row did until 23.08.) made every waiting message a
//    second-class citizen — it had to reach the strip before it could be erledigt. A queued row
//    is now literally the same row: same text, same buttons, same ✕, rendered by the same three
//    components below. Its body tap runs the message's own move (lib/meldungen · meldungTap).
//
// A message that has a PLACE stays out of here: ShiftConflictNotice sits inside the Zeitplan it
// is about, CaptureUsageChip inside the capture surface. Both are uncoverable by construction —
// this strip is the answer for everything that cannot be.

/** Mount ONCE, next to the top bar. Renders nothing while nothing is pending. */
export function Meldeleiste() {
  const items = useSyncExternalStore(subscribeMeldungen, getMeldungen, getMeldungen)
  const [wantOpen, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const C = appConfig.copy.meldeleiste

  const { lead, queue, pillTone } = useMemo(() => rankMeldungen(items), [items])

  // DERIVED, never synced: with nothing queued there is no drawer, so the last message being
  // handled closes it by arithmetic. An effect calling setOpen(false) here would cascade a second
  // render for something already knowable — and the latch stays false underneath, so the drawer
  // cannot spring open by itself when the next message arrives.
  const open = wantOpen && queue.length > 0

  // Esc, or a tap anywhere outside, closes the queue. Nothing else about the strip is dismissible.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [open])

  if (!lead) return null

  return (
    // ONE live region for the whole layer, and a polite one: the strip is persistent content that
    // stays until it is handled, not an event that flies past. Four assertive regions talking
    // over each other is what this replaces.
    <div className={`ml t-${lead.tone}`} ref={ref} role="status" aria-live="polite" aria-label={C.region}>
      <div className="ml-row">
        <Icon id={lead.icon} className="ml-ic" />
        <MeldungBody m={lead} />
        <MeldungActions m={lead} />
        {queue.length > 0 && (
          // A DISCLOSURE, not a counter: the chevron leads, points at the list it opens and turns
          // over once it is open — «there is more below» has to be readable without counting.
          // The number rides along because how many are waiting is real information, and the tone
          // does too, so a due Wiedervorlage behind an alarm is announced by the very control
          // that hides it. Outside .ml-act on purpose: on a phone the actions drop to a second
          // line and this must stay beside the text.
          <button
            type="button"
            className={`ml-more${pillTone === 'alarm' || pillTone === 'warn' ? ` t-${pillTone}` : ''}`}
            aria-expanded={open}
            aria-label={open ? C.less : fillTemplate(C.more, { n: queue.length })}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon id="chevron-down" />{queue.length}
          </button>
        )}
        <MeldungDismiss m={lead} />
      </div>
      {open && (
        <div className="ml-list">
          {queue.map((m) => (
            <div key={m.id} className={`ml-li t-${m.tone}`}>
              <Icon id={m.icon} className="ml-ic" />
              {/* the body tap navigates — get the list out of the way of what it just opened.
                  The buttons do not close it: handling one of four queued messages should leave
                  the other three where the operator is reading them. */}
              <MeldungBody m={m} onNavigate={() => setOpen(false)} />
              <MeldungActions m={m} />
              <MeldungDismiss m={m} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The message as a sentence, and the row's own tap where it has one — a plain text column
 *  where it has none, never a dead button. */
function MeldungBody({ m, onNavigate }: { m: Meldung; onNavigate?: () => void }) {
  const tap = meldungTap(m)
  const text = (
    <>
      <span className="ml-title">{m.title}</span>
      {m.sub && <span className="ml-sub">{m.sub}</span>}
    </>
  )
  if (!tap) return <span className="ml-txt">{text}</span>
  return (
    <button type="button" className="ml-txt" onClick={() => { tap(); onNavigate?.() }}>{text}</button>
  )
}

/** The message's own buttons, at most two. Rendered for the lead row and every queued row from
 *  the same code — «whatever the lead row can do, its queued twin can do» is not a rule anybody
 *  has to remember here, it is the absence of a second code path. */
function MeldungActions({ m }: { m: Meldung }) {
  if (!m.actions?.length) return null
  return (
    <span className="ml-act">
      {m.actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className={`ml-btn${a.primary ? ' prim' : ''}`}
          disabled={a.disabled}
          onClick={a.onClick}
        >
          {a.icon && <Icon id={a.icon} className={a.busy ? 'spin' : undefined} />}{a.label}
        </button>
      ))}
    </span>
  )
}

/** The ✕, where waving the message away is legitimate at all (lib/meldungen · dismiss). */
function MeldungDismiss({ m }: { m: Meldung }) {
  if (!m.dismiss) return null
  return (
    <button type="button" className="ml-x" aria-label={m.dismiss.label} onClick={m.dismiss.onClick}>
      <Icon id="close" />
    </button>
  )
}
