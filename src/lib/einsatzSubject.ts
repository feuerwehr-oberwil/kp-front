import { appConfig } from '../config/appConfig'
import { fillTemplate, fmtWhen } from './format'
import type { ConfirmLine } from './overlays/ConfirmCard'
import type { IncidentMeta } from './incidents'

/** The Einsatz a lifecycle confirm acts on – «**Zimmerbrand** – Zeit Alarmierung 23:58» – for
 *  `ConfirmSpec.subject`, the line right above the buttons (duck sweep LISTS.11, owner 17.11.2026:
 *  «Abschliessen» on the wrong row of «Alle Einsätze» must say WHICH Einsatz it ends, next to the
 *  button that ends it). An Übung says so in the name. Every close, reopen and delete that can be
 *  started for an Einsatz other than the one on screen names it this way. */
export function einsatzSubject(i: Pick<IncidentMeta, 'title' | 'started_at' | 'is_exercise'>): ConfirmLine {
  const h = appConfig.copy.history
  return {
    head: i.is_exercise ? fillTemplate(h.confirmSubjectExercise, { name: i.title }) : i.title,
    text: fillTemplate(h.confirmSubject, { t: fmtWhen(i.started_at, { todayShort: true }) }),
  }
}
