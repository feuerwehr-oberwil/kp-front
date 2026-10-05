import { Icon } from '../lib/icons'
import type { ChecklistTemplate } from '../lib/checklists'
import { checklistAssetUrl } from '../lib/checklists'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DiagramFigure, PhoneLinked } from './ChecklistReference'
import s from './ManualReader.module.css'

// Reading view for one Anleitung (kind: manual, 05.10.2026): a device's instructions as big
// numbered steps — read, never ticked, so there is no state, no progress and nothing to undo.
// A step may carry a red «Achtung» line, a quiet tip, and pictures (asset pages
// `checklists:<id>:p<N>`, prefetched for offline by lib/checklists · warmManualImages) that open
// in the app's one picture viewer, like a playbook diagram.

/** `2026-09-14` → `14.09.2026`; anything else verbatim (the server only lets dates through). */
const fmtDay = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export function ManualReader({ manual }: { manual: ChecklistTemplate }) {
  const CL = appConfig.copy.checklists
  const meta = [
    manual.device,
    manual.updated ? fillTemplate(CL.manualUpdated, { date: fmtDay(manual.updated) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <article className={s['mn-doc']}>
      <header className={s['mn-head']}>
        <h2>{manual.title}</h2>
        {meta && <p className={s['mn-meta']}><Icon id="doc" />{meta}</p>}
      </header>
      {manual.subtitle && <p className={s['mn-intro']}><PhoneLinked text={manual.subtitle} /></p>}
      <ol className={s['mn-steps']}>
        {(manual.steps ?? []).map((step, i) => (
          <li key={i} className={s['mn-step']}>
            <span className={s['mn-num']} aria-hidden="true">{i + 1}</span>
            <div className={s['mn-body']}>
              <p className={s['mn-text']}><PhoneLinked text={step.text} /></p>
              {step.details && step.details.length > 0 && (
                <ul className={s['mn-details']}>
                  {step.details.map((d, j) => <li key={j}><PhoneLinked text={d} /></li>)}
                </ul>
              )}
              {step.warning && (
                <p className={s['mn-warn']}>
                  <Icon id="warn" />
                  <span><strong>{CL.manualWarning}</strong> <PhoneLinked text={step.warning} /></span>
                </p>
              )}
              {step.hint && (
                <p className={s['mn-hint']}>
                  <Icon id="info" />
                  <span><PhoneLinked text={step.hint} /></span>
                </p>
              )}
              {(step.images ?? []).map((img) => (
                <DiagramFigure
                  key={img.page}
                  url={checklistAssetUrl(manual.id, img.page)}
                  caption={img.caption}
                  alt={img.caption ?? fillTemplate(CL.manualImageAlt, { n: i + 1 })}
                  openLabel={CL.manualImageOpen}
                />
              ))}
            </div>
          </li>
        ))}
      </ol>
      {manual.source && <p className={s['mn-source']}>{fillTemplate(CL.manualSource, { source: manual.source })}</p>}
    </article>
  )
}
