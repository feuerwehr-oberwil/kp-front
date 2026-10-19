import { Icon } from '../lib/icons'
import type { ChecklistTemplate } from '../lib/checklists'
import { checklistAssetUrl, fmtDay } from '../lib/checklists'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DiagramFigure, PhoneLinked } from './ChecklistReference'
import s from './ManualReader.module.css'

/** Where the open Anleitung stands among its device's chapters (lib/checklists · chapterOf) and
 *  how to move: the reader says «Kapitel k von n» and offers the neighbours at its foot, so a
 *  device is read through at the device without going back to the list (19.10.2026). */
export interface ChapterNav {
  k: number
  n: number
  prev: ChecklistTemplate | null
  next: ChecklistTemplate | null
  onGo: (manualId: string) => void
  /** back to the device's page – the device name in the meta line becomes a link */
  onDevice?: () => void
}

// Reading view for one Anleitung (kind: manual, 05.10.2026): a device's instructions as big
// numbered steps — read, never ticked, so there is no state, no progress and nothing to undo.
// A step may carry a red «Achtung» line, a quiet tip, and pictures (asset pages
// `checklists:<id>:p<N>`, prefetched for offline by lib/checklists · warmManualImages) that open
// in the app's one picture viewer, like a playbook diagram. One of several chapters of a device
// (DeviceManuals) also carries `chapter`: its place in the device and the way to the next.

export function ManualReader({ manual, chapter }: { manual: ChecklistTemplate; chapter?: ChapterNav | null }) {
  const CL = appConfig.copy.checklists
  const rest = [
    chapter ? fillTemplate(CL.chapterOf, { k: chapter.k, n: chapter.n }) : null,
    manual.updated ? fillTemplate(CL.manualUpdated, { date: fmtDay(manual.updated) }) : null,
  ].filter(Boolean).join(' · ')
  const device = manual.device && chapter?.onDevice
    ? <button type="button" className={s['mn-device-link']} onClick={chapter.onDevice}>{manual.device}</button>
    : manual.device
  return (
    <article className={s['mn-doc']}>
      <header className={s['mn-head']}>
        <h2>{manual.title}</h2>
        {(manual.device || rest) && (
          <p className={s['mn-meta']}>
            <Icon id="doc" />
            <span>{device}{manual.device && rest ? ' · ' : ''}{rest}</span>
          </p>
        )}
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
                  url={checklistAssetUrl(manual, img.page)}
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
      {chapter && (chapter.prev || chapter.next) && (
        <nav className={s['mn-chapters']} aria-label={CL.chapterNav}>
          {chapter.prev && (
            <button type="button" className={s['mn-chapter-prev']} onClick={() => chapter.onGo(chapter.prev!.id)}>
              <Icon id="chevron-left" />
              <span><small>{fillTemplate(CL.chapterN, { k: chapter.k - 1 })}</small>{chapter.prev.title}</span>
            </button>
          )}
          {chapter.next && (
            <button type="button" className={s['mn-chapter-next']} onClick={() => chapter.onGo(chapter.next!.id)}>
              <span><small>{fillTemplate(CL.chapterN, { k: chapter.k + 1 })}</small>{chapter.next.title}</span>
              <Icon id="chevron" />
            </button>
          )}
        </nav>
      )}
    </article>
  )
}
