import { useSyncExternalStore } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { rankMeldungen, type Meldung } from '../lib/meldungen'
import { getMeldungen, subscribeMeldungen } from '../lib/useMeldung'

// ══ Die Meldeleiste ══════════════════════════════════════════════════════════════════════
// ONE strip under the top bar, spanned between the two rails, for every message that has no
// place of its own and stays until somebody acts. It replaces five floating banners anchored 4px
// apart on one axis with no stacking rule, four bottom cards sharing one coordinate, five
// z-indexes and four simultaneous role="alert" regions.
//
// Every pending message is a row, and every row is the same row: no lead, no queue, no
// disclosure. That is a decision, taken 23.08. on the numbers — the strip almost always holds
// zero or one message, two is plausible (a due Wiedervorlage plus an alarm), and three needs a
// pile-up that a real Einsatz produced once in sixteen Pendenzen. A permanent mechanism was
// being paid for to fold away a case that hardly occurs, and it cost the buried message a tap.
//
// Two things it deliberately does NOT do:
//  · it does not exist when nothing is pending — `null`, not an empty 52px band. A strip that
//    costs height on a quiet Einsatz is a bad trade, and that is the property that won it the
//    argument against a badge on the nav rail (0px always, but a digit where the 3am rule wants
//    a sentence).
//  · a row BODY does nothing. Until 23.08. it ran the message's own move, so a tap landing
//    anywhere on the strip could take an alarm or confirm dispatch data nobody had read. What
//    acts is the labelled buttons, the ✕ — and, where the message has somewhere to go, the row's
//    TITLE (`Meldung.onOpen`), which is narrower than «the body is a target» on purpose: the
//    words the operator is reading are what they can follow, while the sub-line, the glyph and
//    the empty space beside them stay dead. A link inside a sentence, not a sentence that is a
//    button. That distinction is the whole point — a tap meant to READ still does nothing, but
//    the one message with a destination no longer needs a third button to name it.
//
// There is no cap on the number of rows: four at once make a tall strip for a moment. Adding a
// max-height or a collapse rule would bring back exactly the disclosure this deleted — do it
// only if the field shows the pile-up is real.
//
// A message that has a PLACE stays out of here: ShiftConflictNotice sits inside the Zeitplan it
// is about, CaptureUsageChip inside the capture surface. Both are uncoverable by construction —
// this strip is the answer for everything that cannot be.

/** Mount ONCE, next to the top bar. Renders nothing while nothing is pending. */
export function Meldeleiste() {
  const items = useSyncExternalStore(subscribeMeldungen, getMeldungen, getMeldungen)
  const C = appConfig.copy.meldeleiste

  const rows = rankMeldungen(items)
  if (rows.length === 0) return null
  // The ✕ column is held open only when a ✕ exists to hold it open FOR. Reserving it
  // unconditionally straightened the right edge but left every row of a strip that carries no
  // dismissible message ending 44px short of its own border — empty space with nothing in it.
  const anyDismiss = rows.some((m) => m.dismiss != null)

  return (
    // ONE live region for the whole layer, and a polite one: the strip is persistent content that
    // stays until it is handled, not an event that flies past. Four assertive regions talking
    // over each other is what this replaces.
    <div className="ml" role="status" aria-live="polite" aria-label={C.region}>
      {rows.map((m) => (
        <div key={m.id} className={`ml-row t-${m.tone}`}>
          <Icon id={m.icon} className="ml-ic" />
          <span className="ml-txt">
            <MeldungTitle m={m} />
            {m.sub && <span className="ml-sub">{m.sub}</span>}
          </span>
          <MeldungActions m={m} />
          <MeldungDismiss m={m} column={anyDismiss} />
        </div>
      ))}
    </div>
  )
}

/** The row's title — plain text, or the message's own way in where it has one (`onOpen`).
 *
 *  It is a LINK, not a button: the row's own type, no chrome, and an underline as the whole
 *  signal (08-toasts · `.ml-open`). A title first and a destination second, which is why the
 *  labelled button it replaced is gone: three buttons on the busiest row read as three equal
 *  moves, and «öffnen» is not equal to «erledigt».
 *
 *  The accessible name is the visible title PLUS the full sentence («Erinnerung fällig · In
 *  Verlauf öffnen»). Both halves are needed: the label alone loses which message this is, and
 *  the title alone never says what following it does — and a name that drops the visible words
 *  breaks voice control, which is spoken against what is on the screen (WCAG 2.5.3). */
function MeldungTitle({ m }: { m: Meldung }) {
  if (!m.onOpen) return <span className="ml-title">{m.title}</span>
  return (
    <button
      type="button"
      className="ml-open"
      aria-label={`${m.title} · ${m.onOpen.label}`}
      title={m.onOpen.label}
      onClick={m.onOpen.onClick}
    >
      <span className="ml-title">{m.title}</span>
    </button>
  )
}

/** The message's own buttons, at most two. `min-width` on them (08-toasts) is what keeps the
 *  right edge straight now that the rows are read as a column. */
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

/** The ✕, where waving the message away is legitimate at all (lib/meldungen · dismiss) — and an
 *  invisible stand-in where it is not, so every row's buttons end on the same vertical line.
 *  `column` is false when NO row in the strip is dismissible: then there is no column to align
 *  to and reserving one only pads the strip's right edge. */
function MeldungDismiss({ m, column }: { m: Meldung; column: boolean }) {
  if (!m.dismiss) return column ? <span className="ml-x ghost" aria-hidden="true" /> : null
  return (
    <button type="button" className="ml-x" aria-label={m.dismiss.label} onClick={m.dismiss.onClick}>
      <Icon id="close" />
    </button>
  )
}
