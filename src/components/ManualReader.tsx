import { Icon } from '../lib/icons'
import type { ChecklistTemplate } from '../lib/checklists'
import { checklistAssetUrl, fmtDay } from '../lib/checklists'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DiagramFigure, PhoneLinked } from './ChecklistReference'
import s from './ManualReader.module.css'

/** Where the open Anleitung stands among its device's chapters (lib/checklists · chapterOf) and
 *  how to move: the reader says «Kapitel k von n» and offers the neighbours at its foot, so a
 *  device is read through at the device without going back to the list (19.10.2026). The way UP
 *  to the device is the host's back row above the reader («‹ TLF», components/ListRow · BackRow) –
 *  the one thing at the top (owner pick, 20.10.2026: back on top, prev/next at the foot). */
export interface ChapterNav {
  k: number
  n: number
  prev: ChecklistTemplate | null
  next: ChecklistTemplate | null
  onGo: (manualId: string) => void
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
  return (
    <article className={s['mn-doc']}>
      <header className={s['mn-head']}>
        <h2>{manual.title}</h2>
        {(manual.device || rest) && (
          <p className={s['mn-meta']}>
            <Icon id="doc" />
            <span>{manual.device}{manual.device && rest ? ' · ' : ''}{rest}</span>
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
      {/* the neighbours at the foot: ONE row of two equal buttons, «‹ 2 Kabine» | «4 Saugbetrieb ›»
          – the number and the title, the side says the direction (owner pick, 20.10.2026). The
          first chapter leaves the left half empty, so «next» always stands on the right. */}
      {chapter && (chapter.prev || chapter.next) && (
        <nav className={s['mn-chapters']} aria-label={CL.chapterNav}>
          {chapter.prev && (
            <ChapterStep dir="prev" k={chapter.k - 1} title={chapter.prev.title} onGo={() => chapter.onGo(chapter.prev!.id)} />
          )}
          {chapter.next && (
            <ChapterStep dir="next" k={chapter.k + 1} title={chapter.next.title} onGo={() => chapter.onGo(chapter.next!.id)} />
          )}
        </nav>
      )}
    </article>
  )
}

/** one half of the chapter foot: «‹ 2 Kabine» or «4 Saugbetrieb ›»; named «Kapitel 2: Kabine» */
function ChapterStep({ dir, k, title, onGo }: { dir: 'prev' | 'next'; k: number; title: string; onGo: () => void }) {
  return (
    <button type="button" className={s[`mn-chapter-${dir}`]} onClick={onGo}
      aria-label={`${fillTemplate(appConfig.copy.checklists.chapterN, { k })}: ${title}`}>
      {dir === 'prev' && <Icon id="chevron-left" />}
      <span className={s['mn-chapter-label']}><span className={s['mn-chapter-num']}>{k}</span> {title}</span>
      {dir === 'next' && <Icon id="chevron" />}
    </button>
  )
}
