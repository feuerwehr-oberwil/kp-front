import { appConfig } from '../config/appConfig'
import { dueClock } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'
import type { OpenReminder } from '../lib/reminders'

// The due-Wiedervorlage row of the Meldeleiste. Shows the most urgent due reminder with
// one-tap Erledigt / +10 min; tapping the row itself opens the Verlauf (the third action IS the
// row). Stays up until every due reminder is handled — no silent expiry, the 3am rule — which
// is why it carries no ✕: a due reminder can be erledigt or verschoben, never waved away.
// Actions act on the top (soonest-due) reminder.
//
// ⚠️ Rank 2, and rank 1–2 are never demoted into the queue (lib/meldungen). Until 23.08. this
// was a 440px card at z-45 under a 700px card at z-57, i.e. structurally invisible whenever the
// intake review was open. That is the defect the ranking exists to make impossible.
export function ReminderBanner({ due, onDone, onSnooze, onOpen }: {
  due: OpenReminder[]
  onDone: (r: OpenReminder) => void
  onSnooze: (r: OpenReminder) => void
  onOpen: () => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.journal
  const top = due[0]
  // only a TIMED Erinnerung can ever come due (lib/reminders · isDue), so a row without a
  // Fälligkeit cannot happen — the guard is here so the type says so too
  const clock = top?.dueAt ? dueClock(top.dueAt) : ''
  useMeldung(top == null ? null : {
    id: 'reminder',
    kind: 'reminder',
    tone: 'warn',
    icon: 'bell',
    title: `${due.length > 1 ? C.dueMany.replace('{n}', String(due.length)) : C.dueOne}${clock ? ` · ${clock}` : ''}`,
    sub: top.text,
    actions: [
      { label: C.dueDone, icon: 'check', primary: true, onClick: () => onDone(top) },
      { label: C.dueSnooze, icon: 'clock', onClick: () => onSnooze(top) },
    ],
    onOpen,
  })
  return null
}
