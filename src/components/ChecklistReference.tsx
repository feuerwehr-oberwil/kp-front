import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import type { ContentBlock, RefEntry } from '../lib/checklists'
import { checklistAssetUrl } from '../lib/checklists'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { openPhoto } from '../lib/ui'
import s from './Checklists.module.css'

// Reading view for one EL tactical entry. The list + search live in the rail now
// (ChecklistsView) — this just renders the selected Stichwort's content. Diagram pages from the
// source PDF are served from the reference registry (checklists:<template>:p<N>, PWA-cached),
// resolved via the owning template id — never bundled in /public.

// Make phone numbers tappable (tel:) in reference text — the Telefonliste page and the contact
// numbers embedded in tactical entries. Conservative on purpose: a Swiss number is a leading-0
// group with ≥2 space-separated digit groups, plus the emergency short codes. This never matches
// the bare quantities that fill tactical text (distances/pressures/times/temperatures), because
// those don't start with 0 followed by grouped digits.
const PHONE_RE = /\b0\d{1,3}(?: \d{2,4}){2,}\b|\b(?:1414|112|117|118|143|144|145)\b/g

function withPhoneLinks(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  PHONE_RE.lastIndex = 0
  while ((m = PHONE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <a key={key++} className={s['cl-tel']} href={`tel:${m[0].replace(/\D/g, '')}`}>
        {m[0]}
      </a>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** A source-PDF diagram: a preview that opens the app's full-size picture viewer, because a
 *  Kommandoakten page scaled into a reading column is a picture OF a diagram rather than a
 *  readable one.
 *
 *  ⚠️ `openPhoto` (lib/ui · PhotoZoom), NOT a viewer of our own. The first two attempts here
 *  built one: the first handed pinch to the browser, which does nothing inside a modal dialog,
 *  and the second re-implemented the pan/zoom that PhotoZoom already had — on a module class
 *  that set no `position`, so it rendered at the top of <body>, present in the DOM and invisible
 *  on screen. That is the exact failure `.ui-dialog` is documented against in 08-toasts.css.
 *  One viewer for every picture in the app also means one gesture to learn. */
function DiagramFigure({ url, caption, alt }: { url: string; caption?: string; alt: string }) {
  const CL = appConfig.copy.checklists
  return (
    <figure className={s['cl-ref-fig']}>
      {/* aria-label, not just title: the name would otherwise be computed from the inner img's
          alt, so a screen reader announced the caption twice and never said it could be opened. */}
      <button
        type="button"
        className={s['cl-ref-figbtn']}
        onClick={() => openPhoto(url, { caption, filename: `${alt}.jpg` })}
        title={CL.diagramOpen}
        aria-label={caption ? `${CL.diagramOpen}: ${caption}` : CL.diagramOpen}
      >
        <img src={url} alt={alt} loading="lazy" />
        <span className={s['cl-ref-zoomhint']} aria-hidden="true"><Icon id="search" /></span>
      </button>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

function ContentBlockView({ block, templateId }: { block: ContentBlock; templateId: string | null }) {
  const CL = appConfig.copy.checklists
  if (block.type === 'heading') return <h4 className={s['cl-ref-h']}>{block.text}</h4>
  if (block.type === 'note') return <p className={s['cl-ref-note']}><Icon id="info" />{withPhoneLinks(block.text)}</p>
  if (block.type === 'image') {
    // an image block can only resolve when we know which template it belongs to
    if (!templateId) return null
    return (
      <DiagramFigure
        url={checklistAssetUrl(templateId, block.page)}
        caption={block.caption}
        alt={block.caption ?? fillTemplate(CL.diagramAlt, { page: block.page })}
      />
    )
  }
  if (block.type === 'table') {
    return (
      <figure className={s['cl-ref-tablewrap']}>
        <table className={s['cl-ref-table']}>
          {block.head && (
            <thead>
              <tr>{block.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {block.rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{withPhoneLinks(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    )
  }
  // depth drives the CSS, not an inline margin: a level-0 line is a STEP and a level-1 line is a
  // detail of it, and they have to look different or the list reads as one flat wall
  return (
    <div className={cx(s['cl-ref-bullet'], block.emphasis && s[`em-${block.emphasis}`])} data-level={Math.min(block.level ?? 0, 2)}>
      <span className={s['cl-ref-dot']} />
      <span>{withPhoneLinks(block.text)}</span>
    </div>
  )
}

export function ChecklistEntryReader({ entry, templateId }: { entry: RefEntry | null; templateId: string | null }) {
  const CL = appConfig.copy.checklists
  if (!entry) {
    return (
      <div className={cx(s['cl-placeholder'], s['cl-placeholder-full'])}>
        <Icon id="search" />
        <p>{CL.pickEntry}</p>
      </div>
    )
  }
  return (
    <article className={cx(s['cl-ref-doc'], entry.hazardColor && s[`hz-${entry.hazardColor}`])}>
      <header className={s['cl-ref-doc-head']}>
        {entry.hazardColor && <span className={cx(s['cl-ref-badge'], s[`hz-${entry.hazardColor}`])}>{CL.hazardLabels[entry.hazardColor]}</span>}
        <h2>{entry.title}</h2>
      </header>
      <div className={s['cl-ref-blocks']}>
        {entry.content.map((b, i) => (
          <ContentBlockView key={i} block={b} templateId={templateId} />
        ))}
      </div>
    </article>
  )
}
