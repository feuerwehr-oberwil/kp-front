import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { formatTime } from '../lib/format'
import type { OpenReminder } from '../lib/reminders'

// Persistent due-reminder banner. Shows the most urgent due Wiedervorlage with one-tap
// Erledigt / +10 min / In Verlauf öffnen. Stays up until every due reminder is handled
// (no silent expiry — the 3am rule). Actions act on the top (soonest-due) reminder.
export function ReminderBanner({ due, onDone, onSnooze, onOpen }: {
  due: OpenReminder[]
  onDone: (r: OpenReminder) => void
  onSnooze: (r: OpenReminder) => void
  onOpen: () => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.journal
  if (due.length === 0) return null
  const top = due[0]
  const more = due.length - 1
  return (
    <div className="reminder-banner" role="alert">
      <div className="rb-head">
        <Icon id="bell" />
        <span className="rb-title">{due.length > 1 ? C.dueMany.replace('{n}', String(due.length)) : C.dueOne}</span>
        <span className="rb-due">{formatTime(new Date(top.dueAt))}</span>
      </div>
      <div className="rb-text">{top.text}{more > 0 && <span className="rb-more"> +{more}</span>}</div>
      <div className="rb-actions">
        <button className="rb-btn rb-done" onClick={() => onDone(top)}><Icon id="check" />{C.dueDone}</button>
        <button className="rb-btn" onClick={() => onSnooze(top)}><Icon id="clock" />{C.dueSnooze}</button>
        <button className="rb-btn" onClick={onOpen}><Icon id="history" />{C.dueOpen}</button>
      </div>
    </div>
  )
}
