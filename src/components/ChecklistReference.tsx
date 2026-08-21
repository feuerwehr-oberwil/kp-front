import { useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import type { ContentBlock, RefEntry } from '../lib/checklists'
import { checklistAssetUrl } from '../lib/checklists'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Overlay } from '../lib/overlays'
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

/** A source-PDF diagram: inline preview that opens full-screen, because a Kommandoakten page
 *  scaled into a 14px column is a picture of a diagram rather than a readable one. Full-screen
 *  starts fit-to-window and toggles to 1:1 on tap; at 1:1 the frame scrolls and `touch-action`
 *  hands pinch to the browser, so no gesture library is involved. */
function DiagramFigure({ url, caption, alt }: { url: string; caption?: string; alt: string }) {
  const CL = appConfig.copy.checklists
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  return (
    <>
      <figure className={s['cl-ref-fig']}>
        <button type="button" className={s['cl-ref-figbtn']} onClick={() => { setFull(false); setOpen(true) }} title={CL.diagramOpen}>
          <img src={url} alt={alt} loading="lazy" />
          <span className={s['cl-ref-zoomhint']} aria-hidden="true"><Icon id="search" /></span>
        </button>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      {open && (
        <Overlay open onClose={() => setOpen(false)} className={cx(s['cl-zoom'], 'ui-dialog')} ariaLabel={caption ?? alt}>
          <div className={s['cl-zoom-head']}>
            <span className={s['cl-zoom-cap']}>{caption ?? alt}</span>
            <button type="button" className={s['cl-zoom-x']} onClick={() => setOpen(false)} aria-label={CL.diagramClose}>
              <Icon id="close" />
            </button>
          </div>
          <div className={cx(s['cl-zoom-body'], full && s['is-full'])} onClick={() => setFull((v) => !v)}>
            <img src={url} alt={alt} />
          </div>
          <p className={s['cl-zoom-hint']}>{CL.diagramHint}</p>
        </Overlay>
      )}
    </>
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
  return (
    <div className={cx(s['cl-ref-bullet'], block.emphasis && s[`em-${block.emphasis}`])} style={{ marginLeft: (block.level ?? 0) * 16 }}>
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
