import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { rankMeldungen, type Meldung } from '../lib/meldungen'
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
//  · the +n pill does not PAGE. Paging hides the message you are reading and turns «what else is
//    waiting» into counting; the list answers it in one glance. Tapping a queued row pulls it
//    onto the strip instead (rankMeldungen · pinnedId).
//
// A message that has a PLACE stays out of here: ShiftConflictNotice sits inside the Zeitplan it
// is about, CaptureUsageChip inside the capture surface. Both are uncoverable by construction —
// this strip is the answer for everything that cannot be.

/** Mount ONCE, next to the top bar. Renders nothing while nothing is pending. */
export function Meldeleiste() {
  const items = useSyncExternalStore(subscribeMeldungen, getMeldungen, getMeldungen)
  const [wantOpen, setOpen] = useState(false)
  // the operator pulled a queued row onto the strip; forgotten as soon as that message is handled
  const [pinned, setPinned] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const C = appConfig.copy.meldeleiste

  const { lead, queue, pillTone } = useMemo(() => rankMeldungen(items, pinned), [items, pinned])

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
        {/* the row IS the message's third action where it has one (the Wiedervorlage's «In
            Verlauf öffnen»); without one it is plain text, not a dead button */}
        {lead.onOpen
          ? <button type="button" className="ml-txt" onClick={lead.onOpen}><MeldungText m={lead} /></button>
          : <span className="ml-txt"><MeldungText m={lead} /></span>}
        <span className="ml-act">
          {(lead.actions ?? []).map((a) => (
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
        {queue.length > 0 && (
          // the pill wears the tone of the best WAITING message, so a due Wiedervorlage behind an
          // alarm is announced rather than merely counted. Outside .ml-act on purpose: on a phone
          // the actions drop to a second line and the counter must stay beside the text.
          <button
            type="button"
            className={`ml-more${pillTone === 'alarm' || pillTone === 'warn' ? ' has-crit' : ''}`}
            aria-expanded={open}
            aria-label={open ? C.less : fillTemplate(C.more, { n: queue.length })}
            onClick={() => setOpen((v) => !v)}
          >
            +{queue.length}<Icon id={open ? 'chevron-up' : 'chevron-down'} />
          </button>
        )}
        {lead.dismiss && (
          <button type="button" className="ml-x" aria-label={lead.dismiss.label} onClick={lead.dismiss.onClick}>
            <Icon id="close" />
          </button>
        )}
      </div>
      {open && (
        <div className="ml-list">
          {queue.map((m) => (
            <button key={m.id} type="button" className={`ml-li t-${m.tone}`} onClick={() => { setPinned(m.id); setOpen(false) }}>
              <Icon id={m.icon} className="ml-ic" />
              <span className="ml-li-t">{m.title}{m.sub && <small>{m.sub}</small>}</span>
              <Icon id="chevron" className="ml-li-go" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MeldungText({ m }: { m: Meldung }) {
  return (
    <>
      <span className="ml-title">{m.title}</span>
      {m.sub && <span className="ml-sub">{m.sub}</span>}
    </>
  )
}
