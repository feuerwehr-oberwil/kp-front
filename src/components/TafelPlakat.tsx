import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import { newId } from '../lib/ids'
import { blankRow, nextTrend, putRow, type PlakatListKey, type PlakatProblemSection, type PlakatRowOf } from '../lib/plakat'
import type { PlakatData, PlakatMassnahme, PlakatMittel, PlakatProblem, PlakatPunkt, PlakatTrend, PlakatVerbindung } from '../types'
import { IconButton } from './Button'
import s from './TafelPlakat.module.css'

/** The sheet layout's design width: the poster is laid out at this many px and scaled onto the
 *  Tafel, so it zooms with the paper like everything drawn on it. A3 landscape proportions. */
export const PLAKAT_BASE_W = 1000

const P = () => appConfig.copy.tafel.plakat
const ARROW: Record<PlakatTrend, string> = { up: '➚', same: '=', down: '➘' }

/** which grid a list's rows use (TafelPlakat.module.css) */
const rowClass = (k: PlakatListKey) =>
  k === 'massnahmen' ? s.rowMass : k === 'mittel' || k === 'verbindungen' ? s.rowTbl : k === 'absprachen' ? s.rowAbs : s.rowProb

/** a press on a field must not start a pan/selection on the board under it */
const keep = (e: { stopPropagation: () => void }) => e.stopPropagation()

/**
 * One text field that commits ONCE, on blur or Enter — one undo step per edit, never one per
 * keystroke (the note's rule). Escape puts the stored value back. A remote change shows up as
 * long as the field is not being typed in. `multiline` is a textarea that grows a line instead
 * of clipping a long problem under its tag (still one line of DATA: Enter commits, a pasted
 * line break becomes a space). A one-line field that is too narrow ellipsizes; `title` holds all.
 */
function Field({ value, onCommit, label, placeholder, readOnly, className, multiline = false }: {
  value: string; onCommit: (v: string) => void; label: string; placeholder?: string; readOnly: boolean; className?: string; multiline?: boolean
}) {
  const [v, setV] = useState(value)
  const typing = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!typing.current) setV(value) }, [value])
  // the textarea is as tall as its wrapped text — re-measured when the text or its width changes
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit() } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [v])
  const props = {
    className: cx(s.field, multiline && s.multi, className), value: v, readOnly, title: v || undefined, 'aria-label': label,
    placeholder: readOnly ? undefined : placeholder,
    onFocus: () => { typing.current = true },
    onChange: (e: { target: { value: string } }) => setV(multiline ? e.target.value.replace(/\s*\n\s*/g, ' ') : e.target.value),
    onBlur: () => { typing.current = false; if (v.trim() !== value.trim()) onCommit(v.trim()); else if (v !== value) setV(value) },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      else if (e.key === 'Escape') { setV(value); typing.current = false; const t = e.currentTarget; requestAnimationFrame(() => t?.blur()) }
    },
    onPointerDown: keep,
  }
  return multiline ? <textarea ref={area} rows={1} {...props} /> : <input {...props} />
}

function Check({ on, label, readOnly, onToggle }: { on: boolean; label: string; readOnly: boolean; onToggle: () => void }) {
  return (
    <IconButton label={label} aria-pressed={on} disabled={readOnly} className={cx(s.check, on && s.checked)}
      onPointerDown={keep} onClick={onToggle}>
      {on ? <Icon id="check" /> : <span className={s.tick} aria-hidden="true" />}
    </IconButton>
  )
}

function Trend({ trend, readOnly, onNext }: { trend: PlakatTrend | undefined; readOnly: boolean; onNext: () => void }) {
  const p = P()
  const word = trend === 'up' ? p.trendUp : trend === 'same' ? p.trendSame : trend === 'down' ? p.trendDown : p.trendNone
  return (
    <IconButton label={fillTemplate(p.trendTitle, { trend: word })} disabled={readOnly} className={s.trend} data-trend={trend ?? 'none'}
      onPointerDown={keep} onClick={onNext}>
      <span aria-hidden="true">{trend ? ARROW[trend] : '·'}</span>
    </IconButton>
  )
}

/**
 * A list of rows plus ONE trailing empty row to write into. The trailing row carries a pre-minted
 * id and is rendered in the same keyed list, so the row it becomes on its first commit is the
 * same element — focus stays in the field you tabbed to.
 */
function Rows<K extends PlakatListKey>({ k, rows, readOnly, render }: {
  k: K; rows: PlakatRowOf<K>[]; readOnly: boolean
  render: (r: PlakatRowOf<K>, isNew: boolean) => ReactNode
}) {
  const [pending, setPending] = useState(() => newId('pr'))
  const taken = rows.some((r) => r.id === pending)
  // the trailing row just became a real one: mint the next (React's «adjust state while rendering»)
  if (taken) setPending(newId('pr'))
  const all = readOnly || taken ? rows.map((r) => ({ r, isNew: false })) : [...rows.map((r) => ({ r, isNew: false })), { r: blankRow(k, pending), isNew: true }]
  return <>{all.map(({ r, isNew }) => <div key={r.id} className={cx(s.row, rowClass(k), isNew && s.rowNew)}>{render(r, isNew)}</div>)}</>
}

interface Props {
  data: PlakatData
  readOnly: boolean
  /** 'sheet' = laid out on the Tafel (tablet), 'list' = one column (phone) */
  variant: 'sheet' | 'list'
  /** sheet only: the scale from the design width onto the board */
  scale?: number
  /** sheet only: the board's height in px — a Plakat taller than the paper is fitted onto it */
  fitH?: number
  /** a drawing tool is armed: the poster lets the pen through (sheet only) */
  passive?: boolean
  onChange: (next: PlakatData) => void
  onRemove: () => void
  /** list only: px the floating top bar covers */
  topInset?: number
}

/**
 * «Erstes Plakat (FKS)» — the «Erste Führung» poster as real fields (lib/plakat for the model,
 * persistence and undo). On the tablet it sits ON the Tafel under the ink, scaled with the paper;
 * on a phone it is the same fields in one column.
 */
export function TafelPlakat({ data, readOnly, variant, scale = 1, fitH, passive = false, onChange, onRemove, topInset = 0 }: Props) {
  const p = P()
  // the poster's own (unscaled) height: a full one may outgrow the A4 sheet, and then it is
  // fitted onto the paper — like a plan, never running off it (the board zooms it back up)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [naturalH, setNaturalH] = useState(0)
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el) return
    const measure = () => setNaturalH(el.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [variant])
  const put = <K extends PlakatListKey>(k: K, id: string, patch: Partial<PlakatRowOf<K>>) => {
    const next = putRow(data, k, id, patch)
    if (next !== data) onChange(next)
  }
  const head = (f: 'title' | 'address' | 'alarm' | 'el', v: string) => { if (v !== data[f]) onChange({ ...data, [f]: v }) }

  const problems = (k: PlakatProblemSection, title: string, eyebrow?: string) => (
    <section className={cx(s.box, s[`area_${k}`])} data-plakat={k}>
      <h3 className={s.h}>{eyebrow ? <>{eyebrow} · {title}</> : title}</h3>
      <Rows k={k} rows={data[k]} readOnly={readOnly} render={(r, isNew) => {
        const row = r as PlakatProblem
        return <>
          {isNew ? <span className={s.trendGap} aria-hidden="true" /> : <Trend trend={row.trend} readOnly={readOnly} onNext={() => put(k, row.id, { trend: nextTrend(row.trend) })} />}
          <Field value={row.text} label={title} placeholder={p.newProblem} readOnly={readOnly} className={s.grow} multiline onCommit={(text) => put(k, row.id, { text })} />
          <Field value={row.note ?? ''} label={`${title} · ${p.note}`} placeholder={isNew ? '' : p.note} readOnly={readOnly} className={s.note} onCommit={(note) => put(k, row.id, { note })} />
        </>
      }} />
    </section>
  )

  const table = <K extends 'massnahmen' | 'mittel' | 'verbindungen'>(k: K, title: string, cols: [keyof PlakatRowOf<K> & string, string][], extra?: (r: PlakatRowOf<K>, isNew: boolean) => ReactNode) => (
    <section className={cx(s.box, s[`area_${k}`])} data-plakat={k}>
      <h3 className={s.h}>{title}</h3>
      <div className={cx(s.row, s.thead, rowClass(k))} aria-hidden="true">
        {cols.map(([f, w]) => <span key={f}>{w}</span>)}{extra && <span />}
      </div>
      <Rows k={k} rows={data[k] as PlakatRowOf<K>[]} readOnly={readOnly} render={(r, isNew) => <>
        {cols.map(([f, w], i) => (
          <Field key={f} value={String((r as unknown as Record<string, unknown>)[f] ?? '')} label={`${title} · ${w}`} placeholder={i === 0 ? p.newRow : ''}
            readOnly={readOnly} onCommit={(v) => put(k, r.id, { [f]: v } as Partial<PlakatRowOf<K>>)} />
        ))}
        {extra?.(r, isNew)}
      </>} />
    </section>
  )

  const body = (
    <>
      <header className={s.head}>
        <Icon id="flag" className={s.flag} />
        <span className={s.heading}>{p.heading}</span>
        <Field value={data.title} label={p.title} placeholder={p.title} readOnly={readOnly} className={s.headTitle} onCommit={(v) => head('title', v)} />
        {!readOnly && (
          <IconButton label={p.remove} className={s.remove} onPointerDown={keep} onClick={onRemove}><Icon id="trash" /></IconButton>
        )}
        {/* the facts take their own line: the address gets the room instead of being cut */}
        <span className={s.headBreak} aria-hidden="true" />
        <Field value={data.address} label={p.address} placeholder={p.address} readOnly={readOnly} className={s.headAddr} onCommit={(v) => head('address', v)} />
        <span className={s.headLabel}>{p.alarm}</span>
        <Field value={data.alarm} label={p.alarm} placeholder="--:--" readOnly={readOnly} className={s.headTime} onCommit={(v) => head('alarm', v)} />
        <span className={s.headLabel}>{p.el}</span>
        <Field value={data.el} label={p.el} placeholder={p.el} readOnly={readOnly} className={s.headEl} onCommit={(v) => head('el', v)} />
      </header>
      <div className={s.grid}>
        {problems('front', p.front, p.problems)}
        {problems('ordnung', p.ordnung)}
        {problems('sanitaet', p.sanitaet)}
        {problems('spezial', p.spezial)}
        {table('massnahmen', p.massnahmen, [['was', p.was], ['wer', p.wer], ['wann', p.wann]], (r, isNew) => isNew
          ? <span className={s.checkGap} aria-hidden="true" />
          : <Check on={!!(r as PlakatMassnahme).done} label={p.done} readOnly={readOnly} onToggle={() => put('massnahmen', r.id, { done: !(r as PlakatMassnahme).done })} />)}
        {table('mittel', p.mittel, [['formation', p.formation], ['pers', p.pers], ['wo', p.wo]] as [keyof PlakatMittel & string, string][])}
        {table('verbindungen', p.verbindungen, [['funktion', p.funktion], ['kanal', p.kanal], ['ruf', p.ruf]] as [keyof PlakatVerbindung & string, string][])}
        <section className={cx(s.box, s.area_absprachen)} data-plakat="absprachen">
          <h3 className={s.h}>{p.absprachen}<span className={s.count}>{data.absprachen.filter((r) => r.done).length} / {data.absprachen.length}</span></h3>
          <Rows k="absprachen" rows={data.absprachen} readOnly={readOnly} render={(r, isNew) => {
            const row = r as PlakatPunkt
            return <>
              {isNew ? <span className={s.checkGap} aria-hidden="true" /> : <Check on={!!row.done} label={row.text} readOnly={readOnly} onToggle={() => put('absprachen', row.id, { done: !row.done })} />}
              <Field value={row.text} label={p.absprachen} placeholder={p.newRow} readOnly={readOnly} className={cx(s.grow, row.done && s.doneText)} onCommit={(text) => put('absprachen', row.id, { text })} />
            </>
          }} />
        </section>
      </div>
    </>
  )

  if (variant === 'list') return <div className={cx(s.plakat, s.list)} style={{ paddingTop: topInset }} data-testid="tafel-plakat">{body}</div>
  const k = fitH && naturalH * scale > fitH ? fitH / naturalH : scale
  const style: CSSProperties = { width: PLAKAT_BASE_W, transform: `translateX(${(PLAKAT_BASE_W * (scale - k)) / 2}px) scale(${k})` }
  return <div ref={sheetRef} className={cx(s.plakat, s.sheet, passive && s.passive)} style={style} data-testid="tafel-plakat">{body}</div>
}
