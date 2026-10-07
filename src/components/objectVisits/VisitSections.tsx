// The parts of a visit page: Datum & Begleitung, the checklist rows, Bemerkungen, Fotos and
// Korrekturvorschläge — editable for a capture role on a draft (or a correction), read-only
// everywhere else. Every edit goes through `onEdit`, which stores it on the device at once.

import { useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, unitLabel } from '../../lib/format'
import type { Item } from '../../lib/checklists'
import { Segmented } from '../Segmented'
import { DateTimeField } from '../TimeField'
import { answerStats, inputOf, isAnswered, localIso } from '../../objectVisits/doc'
import { rememberWith, splitPeople } from '../../objectVisits/devicePrefs'
import type { Answer, VisitDoc, VisitPhoto, VisitProposal } from '../../objectVisits/types'
import { Section, Thumb } from './common'
import { answerText, fmtDate, fmtWhen, plural } from './ovFormat'
import s from './ObjectVisits.module.css'

type Edit = (fn: (d: VisitDoc) => VisitDoc) => void

// ─── Datum & Begleitung ────────────────────────────────────────────────────────────────────

export function DetailsCard({ doc, readOnly, onEdit }: { doc: VisitDoc; readOnly: boolean; onEdit: Edit }) {
  const C = appConfig.copy.objectVisits
  const withText = (doc.with ?? []).join(', ')
  if (readOnly) return null
  // at the TOP of the visit: «Von» is typed (the accounts are shared station logins) and starts
  // with this device's last names; the date starts as «now» and only a back-entry changes it
  return (
    <div className={`${s.card} ${s.cardPad}`}>
      <WithField value={withText} placeholder={C.withPlaceholder} label={C.with}
        onCommit={(list) => {
          rememberWith(list)
          onEdit((d) => {
            const next = { ...d }
            if (list.length) next.with = list
            else delete next.with
            return next
          })
        }} />
      {/* the app's own wheel picker with «Jetzt», 24h on every device (owner, 05.10.2026) — the
          native datetime-local showed «10/05/2026, 02:17 PM» on an English iPhone */}
      <label className={s.field}>
        <span>{C.visitedAt}</span>
        <DateTimeField
          className={s.dateField} ariaLabel={C.visitedAt} value={doc.visitedAt} required
          onCommit={(iso) => {
            if (iso) onEdit((d) => ({ ...d, visitedAt: localIso(new Date(iso)) }))
          }}
        />
      </label>
    </div>
  )
}

/** «Von»: typed as one line, stored as a list. */
function WithField({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder: string; onCommit: (list: string[]) => void }) {
  const [text, setText] = useState(value)
  return (
    <label className={s.field}>
      <span>{label}</span>
      <input
        className={`ip-input ${s.input}`} value={text} placeholder={placeholder} autoComplete="off" autoCapitalize="words"
        onChange={(e) => {
          setText(e.target.value)
          onCommit(splitPeople(e.target.value))
        }}
      />
    </label>
  )
}

// ─── the checklist ─────────────────────────────────────────────────────────────────────────

export function ChecklistSection({ doc, readOnly, pending, onEdit, onTakePhoto, onOpenPhoto }: {
  doc: VisitDoc
  readOnly: boolean
  /** photo ids not yet on the server (their tile wears the upload badge) */
  pending: Set<string>
  onEdit: Edit
  onTakePhoto: (itemId: string | null) => void
  onOpenPhoto: (attId: string) => void
}) {
  const t = doc.checklist
  if (!t) return null
  const st = answerStats(doc)
  const phases = t.phases ?? []
  return (
    <Section title={t.title} aside={`${st.answered}/${st.total}`}>
      <div className={s.card}>
        {phases.map((p) => (
          <div key={p.id}>
            {phases.length > 1 && <div className={s.phase}>{p.title}</div>}
            {(p.items ?? []).map((it) => (
              <ItemRow key={it.id} item={it} doc={doc} readOnly={readOnly} pending={pending}
                onEdit={onEdit} onTakePhoto={onTakePhoto} onOpenPhoto={onOpenPhoto} />
            ))}
          </div>
        ))}
      </div>
    </Section>
  )
}

function setAnswer(d: VisitDoc, id: string, a: Answer | undefined): VisitDoc {
  const answers = { ...d.answers }
  if (a === undefined) delete answers[id]
  else answers[id] = a
  return { ...d, answers }
}

function ItemRow({ item, doc, readOnly, pending, onEdit, onTakePhoto, onOpenPhoto }: {
  item: Item
  doc: VisitDoc
  readOnly: boolean
  pending: Set<string>
  onEdit: Edit
  onTakePhoto: (itemId: string | null) => void
  onOpenPhoto: (attId: string) => void
}) {
  const C = appConfig.copy.objectVisits
  const A = C.answer
  const input = inputOf(item)
  const a = doc.answers[item.id]
  const answered = isAnswered(doc, item)
  const linked = doc.photos.filter((p) => p.item === item.id)
  const thumbs = linked.length > 0 && (
    <div className={s.linked}>
      {linked.map((p) => (
        <button key={p.id} type="button" className={s.tile} aria-label={fillTemplate(C.photoOpen, { caption: p.caption || C.photoTitle })} onClick={() => onOpenPhoto(p.id)}>
          <Thumb visitId={doc.id} attId={p.id} alt={p.caption} pending={pending.has(p.id)} />
        </button>
      ))}
    </div>
  )
  // a tap on the chosen answer takes it back — «nicht geprüft» again (never «Nein»)
  const pick = (v: string) => onEdit((d) => {
    const cur = d.answers[item.id]
    if (cur?.v === v) return setAnswer(d, item.id, undefined)
    return setAnswer(d, item.id, v === 'defect' && cur?.note ? { v, note: cur.note } : { v })
  })

  const head = (
    <div className={s.q}>
      <span>{item.text}{item.required ? ' *' : ''}</span>
      {!answered && !readOnly && (
        <span className="ip-badge ip-badge-arch">{input === 'photo' ? C.photoMissing : C.notChecked}</span>
      )}
    </div>
  )

  if (readOnly) {
    const cls = !answered ? `${s.answerRead} ${s.open}` : a?.v === 'defect' ? `${s.answerRead} ${s.defect}` : s.answerRead
    return (
      <div className={s.ck}>
        {head}
        {input !== 'photo' && <span className={cls}>{answerText(item, a)}{a?.note ? ` · ${a.note}` : ''}</span>}
        {thumbs}
      </div>
    )
  }

  const segOptions =
    input === 'check' ? [{ value: 'ok', label: A.ok }, { value: 'defect', label: A.defect }, { value: 'na', label: A.na }]
      : input === 'yesno' ? [{ value: 'yes', label: A.yes }, { value: 'no', label: A.no }]
        : input === 'choice' ? (item.options ?? []).map((o) => ({ value: o.id, label: o.label }))
          : null

  return (
    <div className={s.ck}>
      {head}
      {segOptions && (
        <div className={s.wide}>
          <Segmented ariaLabel={item.text} options={segOptions} value={typeof a?.v === 'string' ? a.v : undefined} onChange={pick} />
        </div>
      )}
      {input === 'text' && (
        <textarea
          className={`ip-textarea ${s.input}`} rows={2} value={typeof a?.v === 'string' ? a.v : ''} aria-label={item.text}
          onChange={(e) => { const v = e.target.value; onEdit((d) => setAnswer(d, item.id, v ? { v } : undefined)) }}
        />
      )}
      {input === 'number' && (
        <NumberField value={typeof a?.v === 'number' ? a.v : null} unit={item.unit} label={item.text}
          onChange={(n) => onEdit((d) => setAnswer(d, item.id, n == null ? undefined : { v: n }))} />
      )}
      {input === 'check' && a?.v === 'defect' && (
        <div className={`form-warn ${s.defect}`}>
          <textarea
            className={`ip-textarea ${s.input}`} rows={2} value={a.note ?? ''} placeholder={C.defectNotePlaceholder} aria-label={C.defectNote}
            onChange={(e) => {
              const note = e.target.value
              onEdit((d) => setAnswer(d, item.id, note ? { v: 'defect', note } : { v: 'defect' }))
            }}
          />
          <div className={s.inline}>
            {thumbs}
            <button type="button" className="form-warn-act" onClick={() => onTakePhoto(item.id)}><Icon id="cam" /> {C.addPhoto}</button>
          </div>
        </div>
      )}
      {input === 'photo' && (
        <>
          {thumbs}
          <button type="button" className="ip-btn" onClick={() => onTakePhoto(item.id)}><Icon id="cam" />{C.takePhoto}</button>
        </>
      )}
      {input !== 'photo' && !(input === 'check' && a?.v === 'defect') && thumbs}
    </div>
  )
}

/** A number typed as text — «3,» on the way to «3,5» must survive the keystroke. */
function NumberField({ value, unit, label, onChange }: { value: number | null; unit?: string; label: string; onChange: (n: number | null) => void }) {
  const [text, setText] = useState(value == null ? '' : String(value))
  return (
    <div className={s.inline}>
      <input
        className={`ip-input ${s.input}`} inputMode="decimal" value={text} aria-label={label}
        placeholder={appConfig.copy.objectVisits.valuePlaceholder}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          const t = raw.trim().replace(',', '.')
          if (!t) { onChange(null); return }
          const n = Number(t)
          if (Number.isFinite(n)) onChange(n)
        }}
      />
      {unit && <span className={s.unit}>{unitLabel(unit)}</span>}
    </div>
  )
}

// ─── Bemerkungen ───────────────────────────────────────────────────────────────────────────

export function NotesSection({ doc, readOnly, onEdit }: { doc: VisitDoc; readOnly: boolean; onEdit: Edit }) {
  const C = appConfig.copy.objectVisits
  if (readOnly && !doc.notes.trim()) return null
  return (
    <Section title={C.notes}>
      <div className={`${s.card} ${s.cardPad}`}>
        {readOnly
          ? <p className={s.sumText} style={{ whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{doc.notes}</p>
          : (
            <textarea
              className={`ip-textarea ${s.textarea}`} value={doc.notes} placeholder={C.notesPlaceholder} aria-label={C.notes}
              onChange={(e) => { const notes = e.target.value; onEdit((d) => ({ ...d, notes })) }}
            />
          )}
      </div>
    </Section>
  )
}

// ─── Fotos ─────────────────────────────────────────────────────────────────────────────────

export function PhotosSection({ doc, readOnly, pending, onTakePhoto, onOpenPhoto }: {
  doc: VisitDoc
  readOnly: boolean
  pending: Set<string>
  onTakePhoto: (itemId: string | null) => void
  onOpenPhoto: (attId: string) => void
}) {
  const C = appConfig.copy.objectVisits
  if (readOnly && doc.photos.length === 0) return null
  return (
    <Section title={C.photos} count={doc.photos.length}>
      <div className={s.card}>
        <div className={s.grid}>
          {doc.photos.map((p: VisitPhoto) => (
            <button key={p.id} type="button" className={s.tile} onClick={() => onOpenPhoto(p.id)}
              aria-label={fillTemplate(C.photoOpen, { caption: p.caption || C.photoTitle })}>
              <Thumb visitId={doc.id} attId={p.id} alt={p.caption} pending={pending.has(p.id)} />
              {p.caption && <span className={s.cap}>{p.caption}</span>}
            </button>
          ))}
          {!readOnly && (
            // the ONE dashed add in the app: a placeholder for a file (AGENTS.md · Small roles)
            <button type="button" className={s.addTile} onClick={() => onTakePhoto(null)}>
              <Icon id="cam" /><span>{C.addPhoto}</span>
            </button>
          )}
        </div>
      </div>
    </Section>
  )
}

// ─── Korrekturvorschläge ───────────────────────────────────────────────────────────────────

export function ProposalsSection({ doc, readOnly, onOpen, onAdd }: {
  doc: VisitDoc
  readOnly: boolean
  onOpen: (p: VisitProposal) => void
  onAdd: () => void
}) {
  const C = appConfig.copy.objectVisits
  if (readOnly && doc.proposals.length === 0) return null
  const sub = (p: VisitProposal) => p.current
    ? fillTemplate(C.proposalRow, { current: p.current, proposed: p.proposed })
    : fillTemplate(C.proposalRowNew, { proposed: p.proposed })
  return (
    <Section title={C.proposals} count={doc.proposals.length}>
      <div className={s.card}>
        {doc.proposals.map((p) => {
          const inner = (
            <>
              <Icon id="pen" className={s.rowGlyph} />
              <span className={s.rowMain}>
                <span className={s.rowTitle}>{p.label}</span>
                <span className={s.rowSub}>{sub(p)}{p.reason ? ` · ${p.reason}` : ''}</span>
              </span>
              {!readOnly && <Icon id="chevron" className={s.chev} />}
            </>
          )
          return readOnly
            ? <div key={p.id} className={s.rowStatic}>{inner}</div>
            : <button key={p.id} type="button" className={s.row} onClick={() => onOpen(p)}>{inner}</button>
        })}
        {!readOnly && (
          <button type="button" className={`${s.row} ${s.add}`} onClick={onAdd}><Icon id="plus" />{C.proposalAdd}</button>
        )}
      </div>
    </Section>
  )
}

// ─── the completed summary ─────────────────────────────────────────────────────────────────

export function SummaryCard({ doc, byName }: { doc: VisitDoc; byName?: string | null }) {
  const C = appConfig.copy.objectVisits
  const st = answerStats(doc)
  // «Von» is who visited (typed); the signed-in account only where nobody was typed
  const people = (doc.with ?? []).length ? (doc.with ?? []).join(', ') : (byName ?? '')
  const parts = [
    st.total ? fillTemplate(C.countOk, { n: st.ok }) : null,
    st.defects ? plural(st.defects, C.defectsOne, C.defectsMany) : null,
    st.open ? fillTemplate(C.countOpen, { n: st.open }) : null,
    doc.photos.length ? plural(doc.photos.length, C.photosOne, C.photosMany) : null,
    doc.proposals.length ? plural(doc.proposals.length, C.proposalsOne, C.proposalsMany) : null,
  ].filter(Boolean)
  return (
    <div className={`${s.card} ${s.cardPad}`}>
      <div className={s.sumHead}>
        <span className={s.sumTitle}>{doc.checklist?.title ?? C.title}</span>
        {st.defects > 0 && <span className="ip-badge ip-badge-todo">{plural(st.defects, C.defectsOne, C.defectsMany)}</span>}
      </div>
      <p className={s.sumText}>
        {`${fmtDate(doc.visitedAt)} ${fmtWhen(doc.visitedAt).split(' ').pop()}`}{people ? ` · ${people}` : ''}
        {parts.length > 0 && <><br />{parts.join(' · ')}</>}
      </p>
    </div>
  )
}
