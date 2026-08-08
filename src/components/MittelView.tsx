import { useEffect, useMemo, useState } from 'react'
import { clearDraft, keepDraft, readDraft } from '../lib/draftKeep'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig, type DeploymentMittelItem, type DeploymentMittelSource } from '../lib/deploymentConfig'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { cx } from '../lib/cx'
import { toast } from '../lib/ui'
import { Overlay, Sheet } from '../lib/overlays'
import { Combo } from './Combo'
import { Stepper } from './Stepper'
import { Segmented } from './Segmented'
import { EmptyState } from './EmptyState'
import type { MittelEntry, MittelStatus } from '../types'
import {
  visibleMittel, groupBySource, currentLineFor, currentMengeFor, availableFor, mittelListGroups, groupCatalogue,
  type CurrentMittel, type MittelListCell, type MittelListRow,
} from '../lib/mittel'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import s from './Mittel.module.css'

/** What the sheet hands back on every save: the material+unit+source identity plus the new
 *  running TOTAL. App.tsx turns it into an append-only event (no-op if unchanged). */
export interface MittelDraft {
  materialId?: string
  label: string
  unit: string
  sourceId?: string
  sourceLabel?: string
  menge: number
  /** Retablierung state: a value sets it, `null` clears it, omitted keeps the current one
   *  (so quantity edits and composer saves never wipe a set status). */
  status?: MittelStatus | null
  /** free remark: same value / null / omitted semantics as `status`, so editing a quantity
   *  never wipes a remark somebody wrote. */
  note?: string | null
  /** nominal Bestand of a hand-added line — what «noch N» counts down from. Same value / null /
   *  omitted semantics as `note`. Catalogue materials get theirs from the config instead. */
  stock?: number | null
  /** remove the line for good. Only the pencil dialog sets this: stepping to 0 now means
   *  «nothing used», not «gone». */
  deleted?: boolean
}

/** The largest stock still worth drawing as dots. Seven is where subitizing gives out — up to
 *  it you SEE «zwei von sieben», past it you start counting pips, which is slower than reading
 *  the number. Keyed to the stock, never to the current count, so a row keeps its shape all
 *  through the Einsatz instead of flipping format halfway. */
const DOTS_MAX_STOCK = 7

/** The identity of one recorded line: material + unit + source (see lib/mittel · mittelKey). */
type MatProbe = Pick<MittelEntry, 'materialId' | 'label' | 'unit' | 'sourceId' | 'sourceLabel'>

/** What the pencil opened on: the line's identity, its current count, and whether it is a
 *  hand-added one — only those can be renamed, re-united, re-sourced, given a Bestand or
 *  removed. A catalogue row's name and unit ARE the config; the pencil only writes its remark. */
interface EditTarget {
  probe: MatProbe
  menge: number
  label: string
  note: string
  custom: boolean
  stock?: number
}

/** Remaining stock, glanceable: filled dots = still there, empty = used (small stocks); larger
 *  stocks fall back to a «noch N» chip. Amber when low, red at nothing left / over-use. */
function StockDots({ remaining, total, label }: { remaining: number; total: number; label: string }) {
  const M = appConfig.copy.mittel
  const st = remaining <= 0 ? 'out' : total > 0 && remaining <= total * 0.25 ? 'low' : 'ok'
  const aria = fillTemplate(M.stockAria, { label, remaining: Math.max(0, remaining), total })
  if (total > DOTS_MAX_STOCK) {
    return (
      <span className={cx(s.noch, st === 'low' && s.low, st === 'out' && s.over)} title={aria}>
        {fillTemplate(M.noch, { n: Math.max(0, remaining) })}
      </span>
    )
  }
  return (
    <span className={cx(s.dots, st === 'low' && s.low, st === 'out' && s.over)} role="img" aria-label={aria} title={aria}>
      {Array.from({ length: total }, (_, i) => <i key={i} className={cx(i < remaining && s.dotOn)} />)}
    </span>
  )
}

// The Mittel surface: a deliberately lean material-use log. ONE primary list (decision
// 2026-07-09): the whole catalogue grouped by category, every row directly editable with a
// ±stepper — the stepper value IS «verwendet», remaining stock reads as dots. Materials
// stocked on several vehicles expand to per-source stepper sub-rows. Free-typed lines live
// in a trailing «Weitere» group (the composer exists only for those). «nach Quelle» stays as
// the second view — the Nachschub question (what does the TLF need back).
export function MittelView({ entries, canEdit, onSave, captureUsage }: {
  entries: MittelEntry[]
  canEdit: boolean
  onSave: (d: MittelDraft) => void
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
}) {
  const M = appConfig.copy.mittel
  const cfg = getDeploymentConfig().mittel
  const catalogue = cfg?.catalogue ?? appConfig.mittel.catalogue
  const sources = cfg?.sources ?? appConfig.mittel.sources
  const units = cfg?.units?.length ? cfg.units : appConfig.mittel.units
  const categorised = catalogue.some((c) => c.category)

  const [view, setView] = useState<'list' | 'source'>('list')
  const [adding, setAdding] = useState(false)
  // multi-source rows expanded to their per-source stepper sub-rows
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const current = useMemo(() => visibleMittel(entries), [entries])
  const lines = current.length
  const bySource = useMemo(() => groupBySource(current, M.noSource), [current, M.noSource])
  const groups = useMemo(
    () => mittelListGroups(entries, catalogue, sources, { other: M.categoryOther, custom: M.customGroup }),
    [entries, catalogue, sources, M.categoryOther, M.customGroup],
  )

  const toggleExpand = (key: string) => setExpanded((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  // stepper / status change on a list cell. EVERY row treats 0 as a normal value — a catalogue
  // row because it IS the catalogue, a hand-added one because it can now be corrected, renamed
  // and removed from the pencil dialog, and a line that disappears under your thumb takes those
  // handles with it. Removal is explicit and lives in that dialog (it used to be «step to 0» plus
  // an undo toast, which put a destructive act one mis-tap from «−» at 1).
  /** The remark of one recorded line, and the writer for it. Only offered where something was
   *  actually logged: an input under every catalogue row would be a wall of empty fields, and
   *  the sentence («an Werkhof übergeben») only exists once the material does. */
  const noteOf = (probe: MatProbe) => currentLineFor(entries, probe)?.note ?? ''
  /** A PENCIL, not a field in the row: an input beside the ±stepper squeezed the material name
   *  down to «Auff…», and the name is what the row is for. The pencil carries a dot when a
   *  remark exists and opens a small dialog, where a sentence has room to be written — and, on a
   *  hand-added line, where its Bezeichnung, Einheit, Quelle and Bestand can still be corrected.
   *  A catalogue row has none of those to offer: its name and unit ARE the config. */
  const noteField = (probe: MatProbe, menge: number, label: string, custom = false) => {
    const line = currentLineFor(entries, probe)
    const note = line?.note ?? ''
    if (!canEdit) return note ? <div className={s.rowNoteRo}>{note}</div> : null
    return (
      <button
        type="button" className={cx(s.rowNoteBtn, note && s.hasNote)}
        title={note || (custom ? M.editLabel : M.noteLabel)}
        aria-label={`${label} – ${custom ? M.editLabel : M.noteLabel}`}
        onClick={() => setNoteFor({ probe, menge, label, note, custom, stock: line?.stock })}
      ><Icon id="pen" /></button>
    )
  }


  const [noteFor, setNoteFor] = useState<EditTarget | null>(null)
  const saveCell = (row: MittelListRow, cell: MittelListCell, menge: number) => {
    onSave({
      materialId: row.materialId, label: row.label, unit: row.unit,
      sourceId: cell.sourceId, sourceLabel: cell.sourceLabel, menge,
    })
  }

  // per-row stepper change in the source view appends a new total for that exact line
  const editRow = (c: CurrentMittel, menge: number) => {
    onSave({ materialId: c.materialId, label: c.label, unit: c.unit, sourceId: c.sourceId, sourceLabel: c.sourceLabel, menge })
  }

  /** Remove a hand-added line for good, with the usual undo — the entries are append-only, so
   *  undo is just another save that clears the tombstone. */
  const deleteLine = (probe: MatProbe, menge: number, label: string) => {
    onSave({ ...probe, menge, deleted: true })
    toast(fillTemplate(M.removedToast, { label }), {
      icon: 'trash',
      action: { label: appConfig.copy.undo, onClick: () => onSave({ ...probe, menge, deleted: false }) },
    })
  }

  /** Apply the pencil dialog. A hand-added line is KEYED by label + unit + source, so renaming it
   *  is not an edit but a move: the old key is tombstoned and a new one opened carrying the count,
   *  the remark and the Bestand across. Both events stay in the log, which is what the Verlauf and
   *  the audit trail are for — the sheet just stops showing the old name. */
  const applyEdit = (t: EditTarget, next: { label: string; unit: string; sourceLabel?: string; stock: number | null; note: string }) => {
    const source = sources.find((x) => x.label === (next.sourceLabel ?? '').trim())
    const moved = t.custom && (
      next.label.trim() !== t.probe.label
      || next.unit.trim() !== t.probe.unit
      || (next.sourceLabel ?? '').trim() !== (t.probe.sourceLabel ?? '')
    )
    if (moved) {
      onSave({ ...t.probe, menge: t.menge, deleted: true })
      onSave({
        materialId: t.probe.materialId, label: next.label.trim(), unit: next.unit.trim(),
        sourceId: source?.id, sourceLabel: source?.label ?? (next.sourceLabel?.trim() || undefined),
        menge: t.menge, note: next.note.trim() || null, stock: next.stock,
      })
      return
    }
    onSave({ ...t.probe, menge: t.menge, note: next.note.trim() || null, ...(t.custom ? { stock: next.stock } : {}) })
  }

  const empty = catalogue.length === 0 && lines === 0

  return (
    <>
      {/* opaque backdrop so the Mittel surface reads as its own screen, not a card over the map */}
      <div className={s.backdrop} aria-hidden />
      <div className={s.surface}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{M.title}</h2>
          <p>{lines ? fillTemplate(M.summary, { lines }) : M.summaryEmpty}</p>
        </div>
        <div className={s.headActions}>
          <CaptureUsageChip usage={captureUsage} />
          {/* always shown (disabled while empty) so adding the first position doesn't shift the layout */}
          <Segmented<'list' | 'source'> ariaLabel={M.viewLabel} value={view} onChange={setView}
            options={[
              { value: 'list', label: M.viewList, disabled: lines === 0 },
              { value: 'source', label: M.viewBySource, disabled: lines === 0 },
            ]} />
        </div>
      </header>

      {adding && canEdit && (
        <MittelComposer
          M={M} catalogue={catalogue} sources={sources} units={units} entries={entries} categorised={categorised}
          onCancel={() => setAdding(false)}
          onSubmit={(d) => { onSave(d); setAdding(false) }}
        />
      )}

      {empty ? (
        canEdit ? (
          // the taught action right where the teaching text is (recognition over recall)
          <EmptyState className="empty-fill" icon="box" title={M.emptyTitle} sub={M.emptyHint}
            action={!adding && (
              <button type="button" className="ip-btn primary" onClick={() => setAdding(true)}>
                <Icon id="plus" /><span>{M.add}</span>
              </button>
            )} />
        ) : (
          <EmptyState className="empty-fill" icon="box" title={M.emptyReadonly} />
        )
      ) : view === 'source' && lines > 0 ? (
        <div className={s.list}>
          {bySource.map((g) => (
            <section key={g.sourceKey} className={s.group}>
              <h3 className={cx(s.groupHead, !g.hasSource && s.muted)}>{g.sourceLabel}</h3>
              {g.items.map((c) => {
                const avail = availableFor(catalogue, c.materialId, c.sourceId)
                const over = avail !== undefined && c.menge > avail
                return (
                  <div key={c.key} className={s.row}>
                    <div className={s.rowMain}>
                      <span className={s.rowLabel}>{c.label}</span>
                      {/* ⚠️ Same row shape as «Alle», in the same order: Bestand as dots BEFORE
                          the ±stepper, so the counting buttons sit on one right edge whichever
                          view is open. «In Verwendung» used to write the stock as a «/ 4» chip
                          AFTER the stepper — a different notation for the same fact, and it
                          pushed every ± one chip-width off the alignment of the other view. */}
                      {avail !== undefined && <StockDots remaining={avail - c.menge} total={avail} label={`${c.label} · ${c.sourceLabel ?? ''}`} />}
                      {/* the remark: what a number alone can never say — «an Werkhof übergeben»,
                          «Flasche defekt». It rides beside the count, not out at the row's edge. */}
                      {noteField({ materialId: c.materialId, label: c.label, unit: c.unit, sourceId: c.sourceId, sourceLabel: c.sourceLabel }, c.menge, c.label, !c.materialId)}
                      {/* qty and unit read as one value («3 Stk») — unit trails the number */}
                      {canEdit ? (
                        <div className={s.rowEdit}>
                          <Stepper value={c.menge} min={0} max={9999} over={over} ariaLabel={`${c.label} ${c.unit}`} onChange={(v) => editRow(c, v)} />
                          <span className={s.rowUnit}>{c.unit}</span>
                        </div>
                      ) : (
                        <>
                          <span className={cx(s.rowQty, over && s.over)}>{c.menge}</span>
                          <span className={s.rowUnit}>{c.unit}</span>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      ) : (
        // the unified stepper list — catalogue by category, then the free-typed «Weitere»
        <div className={s.list}>
          {groups.map((g) => (
            <section key={g.category} className={s.group}>
              <h3 className={cx(s.groupHead, g.custom && s.muted)}>{g.category}</h3>
              {g.rows.map((row) => {
                const multi = row.cells.length > 1
                if (!multi) {
                  const cell = row.cells[0]
                  const over = row.totalStock != null && cell.used > row.totalStock
                  return (
                    <div key={row.key} className={s.row}>
                      <div className={s.rowMain}>
                        <span className={s.rowLabel}>{row.label}</span>
                        {/* remaining-stock indicator sits BEFORE the ±stepper so the counting
                            buttons line up on a consistent right edge across rows */}
                        {row.totalStock != null && <StockDots remaining={row.totalStock - row.totalUsed} total={row.totalStock} label={row.label} />}
                        {/* the remark pencil travels WITH the count, not at the row's far edge —
                            it annotates the number, and the eye is already there after a ±tap.
                            Saved as its own append-only event (lib/useMittelActions · saveMittel). */}
                        {/* a hand-added line keeps its pencil at 0 — that dialog is the only way
                            back to its name, unit, Bestand and to removing it on purpose */}
                        {(cell.used > 0 || row.custom) && noteField(
                          { materialId: row.materialId, label: row.label, unit: row.unit, sourceId: cell.sourceId, sourceLabel: cell.sourceLabel },
                          cell.used, row.label, row.custom,
                        )}
                        {canEdit ? (
                          <div className={s.rowEdit}>
                            <Stepper value={cell.used} min={0} max={9999} over={over} ariaLabel={`${row.label} ${row.unit}`} onChange={(v) => saveCell(row, cell, v)} />
                            <span className={s.rowUnit}>{row.unit}</span>
                          </div>
                        ) : (
                          <>
                            <span className={cx(s.rowQty, over && s.over)}>{cell.used}</span>
                            <span className={s.rowUnit}>{row.unit}</span>
                          </>
                        )}
                      </div>
                    </div>
                  )
                }
                const open = expanded.has(row.key)
                return (
                  <div key={row.key} className={cx(s.row, s.rowMulti)}>
                    <button type="button" className={s.rowExpand} aria-expanded={open} onClick={() => toggleExpand(row.key)}>
                      <Icon id={open ? 'chevron-down' : 'chevron'} />
                      <span className={s.rowLabel}>{row.label}</span>
                      {/* stock indicator before the count, matching the single rows */}
                      {row.totalStock != null && <StockDots remaining={row.totalStock - row.totalUsed} total={row.totalStock} label={row.label} />}
                      {/* #8: allow over-use but flag it — count turns red past the available stock */}
                      <span className={cx(s.rowQty, row.totalStock != null && row.totalUsed > row.totalStock && s.over)}>{row.totalUsed}</span>
                      <span className={s.rowUnit}>{row.unit}</span>
                    </button>
                    {open && row.cells.map((cell) => {
                          const cellOver = cell.stock != null && cell.used > cell.stock
                          return (
                        <div key={cell.sourceId ?? cell.sourceLabel ?? ''} className={s.subRow}>
                          <div className={s.rowMain}>
                            <span className={s.subLabel}>{cell.sourceLabel ?? M.noSource}</span>
                            {cell.stock != null && <StockDots remaining={cell.stock - cell.used} total={cell.stock} label={`${row.label} · ${cell.sourceLabel ?? ''}`} />}
                            {cell.used > 0 && noteField(
                              { materialId: row.materialId, label: row.label, unit: row.unit, sourceId: cell.sourceId, sourceLabel: cell.sourceLabel },
                              cell.used, `${row.label} · ${cell.sourceLabel ?? M.noSource}`,
                            )}
                            {canEdit ? (
                              <div className={s.rowEdit}>
                                <Stepper value={cell.used} min={0} max={9999} over={cellOver} ariaLabel={`${row.label} · ${cell.sourceLabel ?? M.noSource}`} onChange={(v) => saveCell(row, cell, v)} />
                              </div>
                            ) : (
                              <span className={cx(s.rowQty, cellOver && s.over)}>{cell.used}</span>
                            )}
                          </div>
                            </div>
                      )
                    })}
                  </div>
                )
              })}
            </section>
          ))}
          {canEdit && !adding && (
            <button type="button" className={s.addCustom} onClick={() => setAdding(true)}>
              <Icon id="plus" /> {M.customMaterial}
            </button>
          )}
        </div>
      )}
      </div>

      {noteFor && (
        <MittelLineDialog
          M={M} target={noteFor} sources={sources} units={units}
          onClose={() => setNoteFor(null)}
          onSave={(next) => { applyEdit(noteFor, next); setNoteFor(null) }}
          onDelete={() => { deleteLine(noteFor.probe, noteFor.menge, noteFor.label); setNoteFor(null) }}
        />
      )}
    </>
  )
}

/** The pencil dialog. On a catalogue row it is what it always was — a remark with room to write
 *  it («an Werkhof übergeben», «Flasche defekt»). On a hand-added line it is also the ONLY place
 *  that line can still be corrected: it was typed once in the composer and then frozen, so a
 *  typo, a wrong Einheit or a forgotten Quelle meant recording the whole thing a second time.
 *  Bestand is here too, because a free-typed material has nowhere else to say how many there
 *  were — without it «noch N» can never appear on a «Weitere» row. */
function MittelLineDialog({ M, target, sources, units, onClose, onSave, onDelete }: {
  M: typeof appConfig.copy.mittel
  target: EditTarget
  sources: DeploymentMittelSource[]
  units: string[]
  onClose: () => void
  onSave: (next: { label: string; unit: string; sourceLabel?: string; stock: number | null; note: string }) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(target.probe.label)
  const [unit, setUnit] = useState(target.probe.unit)
  const [sourceLabel, setSourceLabel] = useState(target.probe.sourceLabel ?? '')
  // empty string, not 0 — «kein Bestand erfasst» and «Bestand 0» are different statements
  const [stock, setStock] = useState(target.stock == null ? '' : String(target.stock))
  const [note, setNote] = useState(target.note)

  const valid = !target.custom || (!!label.trim() && !!unit.trim())
  const submit = () => {
    if (!valid) return
    const n = stock.trim() === '' ? null : Math.max(0, Math.round(Number(stock)))
    onSave({ label, unit, sourceLabel, stock: Number.isFinite(n as number) ? n : null, note })
  }

  return (
    // the standard sheet chrome (.ip-head/.ip-body/.ip-actions each bring their own gutter) —
    // a hand-rolled padding on the popup stacked on top of theirs and the title sat further
    // in than the field under it. `mp-backdrop` because this opens OVER the Mittel sheet.
    <Overlay
      open onClose={onClose} backdropClassName="mp-backdrop"
      className="ip-sheet ip-fit ui-dialog mv-note-dialog" ariaLabel={target.custom ? M.editLabel : M.noteLabel}
    >
      <div className="ip-head"><h2>{target.label}</h2>
        <button className="ip-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ip-body">
        {target.custom && (
          <>
            <label className="ip-field">
              <span>{M.materialLabel}</span>
              <input className="ip-input" autoFocus value={label} maxLength={80} onChange={(e) => setLabel(stripUnprintable(e.target.value))} />
            </label>
            <div className={s.dialogRow}>
              <div className="ip-field">
                <span>{M.unitLabel}</span>
                <Combo value={unit} options={units} placeholder={M.unitPlaceholder} allowCustom clearable={false} onChange={setUnit} />
              </div>
              <label className="ip-field">
                <span>{M.stockLabel}</span>
                <input
                  className="ip-input" type="number" inputMode="numeric" min={0} max={9999}
                  value={stock} placeholder={M.stockPlaceholder} onChange={(e) => setStock(e.target.value)}
                />
              </label>
            </div>
            {sources.length > 0 && (
              <div className="ip-field">
                <span>{M.sourceLabel}</span>
                <Combo value={sourceLabel} options={sources.map((x) => x.label)} placeholder={M.sourcePlaceholder} onChange={setSourceLabel} />
              </div>
            )}
          </>
        )}
        <label className="ip-field">
          <span>{M.noteLabel}</span>
          <textarea
            className="ip-textarea" autoFocus={!target.custom} value={note} placeholder={M.notePlaceholder}
            // the Rapport joins every source line's remark into one cell, so keep each short —
            // an over-long cell cannot be split across pages and used to fail the whole compose
            maxLength={240}
            onChange={(e) => setNote(stripUnprintable(e.target.value))}
          />
        </label>
      </div>
      <div className="ip-actions">
        {/* destructive action to the left, away from Speichern — and only where there is
            something the operator actually put there by hand */}
        {target.custom && (
          <button type="button" className="ip-btn mv-del" onClick={onDelete}>
            <Icon id="trash" /> {M.deleteLine}
          </button>
        )}
        <button type="button" className="ip-btn" onClick={onClose}>{M.cancel}</button>
        <button type="button" className="ip-btn primary" disabled={!valid} onClick={submit}>{M.save}</button>
      </div>
    </Overlay>
  )
}

// The composer: free-typed entries (or a catalogue material with special unit/source) — the
// catalogue itself edits inline via the list steppers, so this is the «Anderes Mittel» path.
/** The composer's kept draft. Not cleared on «Abbrechen»: «weg» and «ich mache gleich weiter»
 *  look identical from here, and losing what was typed is the more expensive mistake. */
const DRAFT_KEY = 'mittel:composer'
const EMPTY_DRAFT = {
  label: '', materialId: undefined as string | undefined, unit: '',
  sourceId: undefined as string | undefined, sourceLabel: undefined as string | undefined, menge: 1,
}

function MittelComposer({ M, catalogue, sources, units, entries, categorised, onCancel, onSubmit }: {
  M: typeof appConfig.copy.mittel
  catalogue: DeploymentMittelItem[]
  sources: DeploymentMittelSource[]
  units: string[]
  entries: MittelEntry[]
  categorised: boolean
  onCancel: () => void
  onSubmit: (d: MittelDraft) => void
}) {
  // ⚠️ The half-filled entry survives this component being UNMOUNTED — which is what happens the
  // moment somebody hops to the Verlauf mid-typing (see lib/draftKeep). Seeded from the keeper,
  // written back on every change; dropped once the Mittel is actually recorded.
  const kept = readDraft(DRAFT_KEY, EMPTY_DRAFT)
  const [label, setLabel] = useState(kept.label)
  const [materialId, setMaterialId] = useState<string | undefined>(kept.materialId)
  const [unit, setUnit] = useState(kept.unit)
  const [sourceId, setSourceId] = useState<string | undefined>(kept.sourceId)
  const [sourceLabel, setSourceLabel] = useState<string | undefined>(kept.sourceLabel)
  const [menge, setMenge] = useState(kept.menge)
  useEffect(() => {
    keepDraft(DRAFT_KEY, { label, materialId, unit, sourceId, sourceLabel, menge })
  }, [label, materialId, unit, sourceId, sourceLabel, menge])

  const pickMaterial = (val: string) => {
    const item = catalogue.find((c) => c.label === val)
    setMaterialId(item?.id)
    setLabel(val)
    setUnit((u) => item?.unit || u || units[0] || appConfig.mittel.defaultUnit)
  }
  const pickSource = (val: string) => {
    if (!val) { setSourceId(undefined); setSourceLabel(undefined); return }
    const item = sources.find((x) => x.label === val)
    setSourceId(item?.id)
    setSourceLabel(val)
  }

  // seed the quantity from the existing running total when this exact material+unit+source is
  // already recorded, so re-adding a line shows/adjusts its total; otherwise default to 1.
  useEffect(() => {
    if (!label.trim() || !unit.trim()) return
    const existing = currentMengeFor(entries, { materialId, label, unit, sourceId, sourceLabel })
    setMenge(existing > 0 ? existing : 1)
  }, [materialId, label, unit, sourceId, sourceLabel, entries])

  const matGroups = useMemo(
    () => categorised ? groupCatalogue(catalogue, M.categoryOther).map((g) => ({ label: g.category, options: g.items.map((i) => i.label) })) : undefined,
    [catalogue, categorised, M.categoryOther],
  )

  const valid = !!label.trim() && !!unit.trim() && menge >= 1
  const submit = () => {
    if (!valid) return
    onSubmit({ materialId, label: label.trim(), unit: unit.trim(), sourceId, sourceLabel, menge })
    clearDraft(DRAFT_KEY) // recorded — the next «erfassen» starts empty
  }

  return (
    /* A MODAL, like every other «… erfassen» in the app. It was an inline band under the header —
       and a band is genuinely better at keeping the list you are adding to visible — but one
       «erfassen» that behaves differently from the others is worse than either pattern applied
       everywhere, and the two forms that could not be bands (Trupp anlegen is seven fields, the
       Gast needs its explanatory line) settled which way «everywhere» had to go. The draft still
       survives leaving the surface, so the one thing the band was protecting is kept. */
    <Sheet open fit title={M.composerTitle} onClose={onCancel} ariaLabel={M.composerTitle}
      footer={<>
        <button type="button" className="ip-btn" onClick={onCancel}>{M.cancel}</button>
        <button type="button" className="ip-btn primary" disabled={!valid} onClick={submit}>{M.save}</button>
      </>}
    >
      <div className={s.composerFields}>
        <div className={s.field}>
          <label>{M.materialLabel}</label>
          <Combo value={label} options={catalogue.map((c) => c.label)} groups={matGroups} placeholder={M.materialPlaceholder}
            allowCustom customLabel={M.customMaterial} clearable={false} onChange={pickMaterial} />
        </div>
        <div className={cx(s.field, s.fieldNarrow)}>
          <label>{M.unitLabel}</label>
          <Combo value={unit} options={units} placeholder={M.unitPlaceholder} allowCustom clearable={false} onChange={setUnit} />
        </div>
        {sources.length > 0 && (
          <div className={s.field}>
            <label>{M.sourceLabel}</label>
            <Combo value={sourceLabel ?? ''} options={sources.map((x) => x.label)} placeholder={M.sourcePlaceholder} onChange={pickSource} />
          </div>
        )}
        <div className={cx(s.field, s.fieldNarrow)}>
          <label>{M.qtyLabel}</label>
          <Stepper value={menge} min={1} max={9999} ariaLabel={M.qtyLabel} onChange={setMenge} />
        </div>
      </div>
    </Sheet>
  )
}
