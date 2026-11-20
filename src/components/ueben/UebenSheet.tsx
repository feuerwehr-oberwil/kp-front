// «Üben»'s sheet (owner pick 2C, 19.11.2026): «Als Nächstes» on top – the step running now, else
// the first topic not through on this device – then ONE short list of the topics, each with how
// far it stands here («2 / 6», ✓ when through – owner pick, 20.11.2026: topics with short steps),
// and «Frei üben»: the Übungsplatz without a task. A topic goes on with its first step not done.
// Opened from both menus' «Üben» row (lib/ueben/session · openUebenSheet); App renders it as a
// lazy chunk and starts the step.

import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'
import { Sheet } from '../../lib/overlays'
import { ALL_TOPICS, nextTopic, placeOf, stepCopy, topicCopy, topicProgress, type StepId } from '../../lib/ueben/catalogue'
import { Button } from '../Button'
import { ListCard, ListGroup, ListRow } from '../ListRow'
import s from './Ueben.module.css'

export default function UebenSheet({ done, current, onClose, onStart, onFree }: {
  done: ReadonlySet<StepId>
  /** the step on the card now – «Als Nächstes» resumes it */
  current: StepId | null
  onClose: () => void
  onStart: (id: StepId) => void
  /** «Frei üben»: the Übungsplatz without a task */
  onFree: () => void
}) {
  const C = appConfig.copy.ueben
  const upTopic = nextTopic(done)
  const up = current && !done.has(current) ? current : upTopic ? topicProgress(upTopic, done).next : null
  const upAt = up ? placeOf(up) : undefined
  return (
    <Sheet open onClose={onClose} title={C.menu}>
      <p className={s.lead}>{C.sheetLead}</p>
      {up && upAt && (
        <div className={s.nextCard} data-ueben-next={up}>
          <span className={s.kicker}>{C.next} · {fillTemplate(C.kicker, { topic: topicCopy(upAt.topic).title, i: upAt.i, n: upAt.n })}</span>
          <span className={s.title}>{stepCopy(up).title}</span>
          <Button variant="primary" className={s.go} onClick={() => onStart(up)}>{upAt.i > 1 ? C.doneNext : C.nextGo}</Button>
        </div>
      )}
      <ListGroup label={C.allDrills}>
        {ALL_TOPICS.map((topic) => {
          const { n, total, next } = topicProgress(topic, done)
          const through = n === total
          const title = topicCopy(topic).title
          const count = fillTemplate(C.stepCount, { n, total })
          return (
            <ListRow
              key={topic}
              data-ueben-topic={topic}
              title={title}
              sub={through ? C.doneMark : n > 0 ? fillTemplate(C.nextStep, { step: stepCopy(next).title }) : fillTemplate(C.steps, { total })}
              end={through ? <Icon id="check" className={s.check} /> : <span className={s.count}>{count}</span>}
              aria-label={`${title} · ${through ? C.doneMark : count}`}
              onClick={() => onStart(next)}
            />
          )
        })}
      </ListGroup>
      <ListCard className={s.free}>
        <ListRow data-ueben-free lead={<Icon id="target" />} title={C.free} sub={C.freeSub} onClick={onFree} />
      </ListCard>
    </Sheet>
  )
}
