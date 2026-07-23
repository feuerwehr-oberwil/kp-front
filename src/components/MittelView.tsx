import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig, type DeploymentMittelItem, type DeploymentMittelSource } from '../lib/deploymentConfig'
import { fillTemplate } from '../lib/format'
import { cx } from '../lib/cx'
import { toast } from '../lib/ui'
import { Combo } from './Combo'
import { Stepper } from './Stepper'
import { Segmented } from './Segmented'
import { EmptyState } from './EmptyState'
import type { MittelEntry, MittelStatus } from '../types'
import {
  visibleMittel, groupBySource, currentMengeFor, availableFor, mittelListGroups, groupCatalogue,
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
}

/** Remaining stock, glanceable: filled dots = still there, empty = used (≤8 total); larger
 *  stocks fall back to a «noch N» chip. Amber when low, red at nothing left / over-use. */
function StockDots({ remaining, total, label }: { remaining: number; total: number; label: string }) {
  const M = appConfig.copy.mittel
  const st = remaining <= 0 ? 'out' : total > 0 && remaining <= total * 0.25 ? 'low' : 'ok'
  const aria = fillTemplate(M.stockAria, { label, remaining: Math.max(0, remaining), total })
  if (total > 8) {
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

  // stepper / status change on a list cell. Catalogue rows treat 0 as a normal value (the
  // row stays — it IS the catalogue); zeroing a custom line removes it — immediately, with an
  // undo toast that re-appends the previous total (entries are append-only, so undo is just
  // another save). Replaces the old blocking confirm (house rule: confirm-with-undo).
  const saveCell = (row: MittelListRow, cell: MittelListCell, menge: number) => {
    const draft: MittelDraft = {
      materialId: row.materialId, label: row.label, unit: row.unit,
      sourceId: cell.sourceId, sourceLabel: cell.sourceLabel, menge,
    }
    onSave(draft)
    if (menge === 0 && cell.used > 0 && row.custom) {
      const prev = cell.used
      toast(fillTemplate(M.removedToast, { label: row.label }), {
        icon: 'trash',
        action: { label: appConfig.copy.undo, onClick: () => onSave({ ...draft, menge: prev }) },
      })
    }
  }

  // per-row stepper change in the source view appends a new total for that exact line.
  // Stepping to 0 removes the line — same delete-now + undo toast, so a misclick on − at 1
  // is one tap away from restored instead of silently gone.
  const editRow = (c: CurrentMittel, menge: number) => {
    const draft: MittelDraft = { materialId: c.materialId, label: c.label, unit: c.unit, sourceId: c.sourceId, sourceLabel: c.sourceLabel, menge }
    onSave(draft)
    if (menge === 0 && c.menge > 0) {
      const prev = c.menge
      toast(fillTemplate(M.removedToast, { label: c.label }), {
        icon: 'trash',
        action: { label: appConfig.copy.undo, onClick: () => onSave({ ...draft, menge: prev }) },
      })
    }
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
                      {/* qty and unit read as one value («3 / 4 Stk») — unit trails the number */}
                      {canEdit ? (
                        <div className={s.rowEdit}>
                          <Stepper value={c.menge} min={0} max={9999} over={over} ariaLabel={`${c.label} ${c.unit}`} onChange={(v) => editRow(c, v)} />
                          {avail !== undefined && <span className={cx(s.avail, over && s.over)}>/ {avail}</span>}
                          <span className={s.rowUnit}>{c.unit}</span>
                        </div>
                      ) : (
                        <>
                          <span className={cx(s.rowQty, over && s.over)}>{c.menge}{avail !== undefined ? ` / ${avail}` : ''}</span>
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
    </>
  )
}

// The composer: free-typed entries (or a catalogue material with special unit/source) — the
// catalogue itself edits inline via the list steppers, so this is the «Anderes Mittel» path.
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
  const [label, setLabel] = useState('')
  const [materialId, setMaterialId] = useState<string | undefined>(undefined)
  const [unit, setUnit] = useState('')
  const [sourceId, setSourceId] = useState<string | undefined>(undefined)
  const [sourceLabel, setSourceLabel] = useState<string | undefined>(undefined)
  const [menge, setMenge] = useState(1)

  const pickMaterial = (val: string) => {
    const item = catalogue.find((c) => c.label === val)
    setMaterialId(item?.id)
    setLabel(val)
    setUnit((u) => item?.unit || u || units[0] || 'Stk')
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
  const submit = () => { if (valid) onSubmit({ materialId, label: label.trim(), unit: unit.trim(), sourceId, sourceLabel, menge }) }

  return (
    <div className={s.composer}>
      <div className={s.composerTitle}>{M.composerTitle}</div>
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
        <div className={s.composerActions}>
          <button type="button" className="ip-btn" onClick={onCancel}>{M.cancel}</button>
          <button type="button" className="ip-btn primary" disabled={!valid} onClick={submit}>{M.save}</button>
        </div>
      </div>
    </div>
  )
}
