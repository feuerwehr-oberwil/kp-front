import { appConfig } from '../config/appConfig'
import { dueClock } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'
import type { OpenReminder } from '../lib/reminders'

// The due-Wiedervorlage row of the Meldeleiste. Shows the most urgent due reminder with
// one-tap Erledigt / +10 min. Stays up until every due reminder is handled — no silent expiry,
// the 3am rule — which is why it carries no ✕: a due reminder can be erledigt or verschoben,
// never waved away. Actions act on the top (soonest-due) reminder.
//
// ⚠️ The third move — «In Verlauf öffnen» — is the row's TITLE, not a button. It was a labelled
// button for an hour on 23.08. and read wrong: three buttons on the strip's busiest row make
// «öffnen» look like a peer of «Erledigt», when one handles the Wiedervorlage and the other only
// goes and looks. As the title it is a link inside the sentence the operator is already reading,
// and the row BODY stays inert (Meldeleiste) — which is what stopped a tap meant to read a
// message from acting on it.
//
// ⚠️ Rank 2, i.e. above everything that goes away by itself (lib/meldungen). Until 23.08. this
// was a 440px card at z-45 under a 700px card at z-57, i.e. structurally invisible whenever the
// intake review was open. That is the defect the ranking exists to make impossible.
export function ReminderBanner({ due, onDone, onSnooze, onOpen, onLagemeldung, lageSub }: {
  due: OpenReminder[]
  onDone: (r: OpenReminder) => void
  onSnooze: (r: OpenReminder) => void
  /** land on the row that raised this item (OpenReminder · rowId) */
  onOpen?: (r: OpenReminder) => void
  /** The Lagemeldung's booking (purpose `lagemeldung`, F3): its row offers [Lagemeldung] [+10′]
   *  instead of [Erledigt] — the way to answer it is to make the report, and «erledigt» without
   *  one would be the forgotten Lagemeldung the rhythm exists to prevent. Absent (a device that
   *  may not send one) → the row is the ordinary Wiedervorlage. */
  onLagemeldung?: () => void
  /** «letzte 21:17 · 5 Änderungen, 1 dringend» — the engine's own count, so the EL knows before
   *  opening whether it is a long or a short call */
  lageSub?: string
}) {
  // ⚠️ ONE ROW PER WIEDERVORLAGE (23.08.). This used to publish a single row titled «2
  // Erinnerungen fällig», whose Erledigt/+10 min acted on the soonest-due one — so the second
  // item could not be reached at all, and the buttons acted on something the row did not name.
  // Each due item is its own message now; they rank together and sort by their own due time.
  return <>{due.map((r) => (r.purpose === 'lagemeldung' && onLagemeldung
    ? <DueLagemeldung key={r.id} r={r} onSnooze={onSnooze} onLagemeldung={onLagemeldung} sub={lageSub} />
    : <DueReminder key={r.id} r={r} onDone={onDone} onSnooze={onSnooze} onOpen={onOpen} />
  ))}</>
}

function DueLagemeldung({ r, onSnooze, onLagemeldung, sub }: {
  r: OpenReminder
  onSnooze: (r: OpenReminder) => void
  onLagemeldung: () => void
  sub?: string
}) {
  const C = appConfig.copy.lagemeldung
  const clock = r.dueAt ? dueClock(r.dueAt) : ''
  useMeldung({
    id: `reminder:${r.id}`,
    kind: 'reminder',
    tone: 'warn',
    icon: 'radio',
    title: `${C.dueTitle}${clock ? ` · ${clock}` : ''}`,
    sub,
    actions: [
      { label: C.dueOpen, primary: true, onClick: onLagemeldung },
      { label: C.dueSnooze, icon: 'clock', onClick: () => onSnooze(r) },
    ],
    // the title's way in IS the primary action — the same door, so it draws no underline
    onOpen: { label: C.dueOpen, onClick: onLagemeldung },
  })
  return null
}

function DueReminder({ r, onDone, onSnooze, onOpen }: {
  r: OpenReminder
  onDone: (r: OpenReminder) => void
  onSnooze: (r: OpenReminder) => void
  onOpen?: (r: OpenReminder) => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.journal
  // only a TIMED Erinnerung can ever come due (lib/reminders · isDue), so a row without a
  // Fälligkeit cannot happen — the guard is here so the type says so too
  const clock = r.dueAt ? dueClock(r.dueAt) : ''
  useMeldung({
    id: `reminder:${r.id}`,
    kind: 'reminder',
    tone: 'warn',
    icon: 'bell',
    title: `${C.dueOne}${clock ? ` · ${clock}` : ''}`,
    sub: r.text,
    actions: [
      { label: C.dueDone, icon: 'check', primary: true, onClick: () => onDone(r) },
      { label: C.dueSnooze, icon: 'clock', onClick: () => onSnooze(r) },
    ],
    // …and the way in, on the title. It can only exist since each due item became its own row:
    // «öffnen» on a row that stood for two Wiedervorlagen could not say WHICH one it would land
    // on. `C.dueOpen` survives as the accessible name — «Erinnerung fällig · 21:40» says what
    // this is, never that it can be followed.
    onOpen: onOpen ? { label: C.dueOpen, onClick: () => onOpen(r) } : undefined,
  })
  return null
}
