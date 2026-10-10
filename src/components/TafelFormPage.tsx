import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { clearDraft, keepDraft, readDraft } from '../lib/draftKeep'
import { useMediaQuery } from '../lib/useIsPhone'
import { appConfig } from '../config/appConfig'
import { getLocaleId } from '../config/copy'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { fillTemplate, hhmm } from '../lib/format'
import { newId } from '../lib/ids'
import { serverNow } from '../lib/serverClock'
import {
  editableColumns, labelText, shownColumns, shownFixedRows, shownSections, tableAddsRows, writtenColumns,
  type QuadSection, type TableSection, type TemplateColumn, type TextSection,
} from '../lib/boardTemplate'
import {
  boxLines, nextTrend, normalizeTime, putField, putHead, putLine, putRow, tableRows, tableSlots,
  type BoardFormData, type FormHead,
} from '../lib/boardForm'
import { NEW, navTarget, type NavAt, type NavKey, type NavSection } from '../lib/boardFormNav'
import { IconButton } from './Button'
import { BoardSignature } from './BoardSignature'
import MiniKarte, { type MiniKarteProps } from './MiniKarte'
import s from './TafelFormPage.module.css'

/**
 * A Tafel PAGE (10.10.2026): one board-template page as a form, laid out like the paper it comes
 * from — the FKS «Erste Führung» poster in two columns, the Handbuch sheets as they are printed.
 * The model, persistence and undo are lib/boardForm; the keyboard is lib/boardFormNav.
 *
 * Every cell commits ONCE — on blur, Enter or Tab — so an edit is one ↶ step, never one per
 * keystroke (the note's rule). Esc puts the stored value back (a second Esc lets go). The trailing
 * empty row of every list carries a pre-minted id, so the row it becomes on its first commit is
 * the same element and focus stays where Tab sent it.
 *
 * ⚠️ A cell writes only what the operator CHANGED since it took the focus (review of #338): a
 * focused cell that was merely passed through never writes its old text back over what another
 * device wrote meanwhile, and while it is untouched it follows the remote change. Typing is never
 * lost: it is written when the cell unmounts, when the page is hidden or closed — and when the
 * Einsatz turned read-only under it (closed elsewhere) it is KEPT on this device (lib/draftKeep)
 * rather than written into a closed record, and offered again once the page is writable.
 *
 * ⚠️ Every box drawn is a box one can write in (owner, round 2): a table's ruled empty rows are
 * live rows, each with its own pre-minted id, and the rows written under a fixed list (the
 * Abspracherapport) type the pre-printed text columns too.
 *
 * DOM order is the template's order, row-major — the Tab order and the iOS ↑↓ bar follow it.
 * Pre-printed cells of a fixed row (Signatur, Bezeichnung, the Traktanden) are text, not inputs, so
 * neither stops on them.
 */

const T = () => appConfig.copy.tafel
const ARROW: Record<string, string> = { up: '➚', same: '=', down: '➘' }

/** what a cell is in the form (and what it writes) */
type Addr =
  /** `slot`: the line / ruling this cell stands on — what a new line or row is written ON */
  | { kind: 'line'; sec: string; box: string; row: string; slot?: number }
  | { kind: 'tag'; sec: string; box: string; row: string }
  | { kind: 'cell'; sec: string; row: string; col: string; slot?: number }
  | { kind: 'field'; sec: string; col: string }
  | { kind: 'head'; col: keyof FormHead }

/** how many pre-printed rows a table shows (they lead `tableRows`) */
const shownFixedCount = (sec: TableSection) => shownFixedRows(sec).length

const HEAD_SEC = '__head'
const HEAD_KEYS: (keyof FormHead)[] = ['title', 'address', 'alarm', 'el']
const keyOf = (sec: string, box: string | undefined, row: string | undefined, col: string | undefined) => `${sec}|${box ?? ''}|${row ?? ''}|${col ?? ''}`
const navAtOf = (a: Addr): NavAt => a.kind === 'line' ? { sec: a.sec, box: a.box, row: a.row }
  : a.kind === 'tag' ? { sec: a.sec, box: a.box, row: a.row, col: 'tag' }
  : a.kind === 'cell' ? { sec: a.sec, row: a.row, col: a.col }
    : a.kind === 'field' ? { sec: a.sec, col: a.col } : { sec: HEAD_SEC, col: a.col }

/** a press on a field must not start a pan or a selection on anything under it */
const keep = (e: { stopPropagation: () => void }) => e.stopPropagation()

interface CellProps {
  k: string
  /** the NEW alias of a trailing row's cell — what a «next empty row» target resolves to */
  kn?: string
  value: string
  label: string
  readOnly: boolean
  time?: boolean
  placeholder?: string
  className?: string
  last?: boolean
  /** where a draft the read-only Einsatz could not take is kept on this device (lib/draftKeep) */
  draftKey?: string
  onCommit: (v: string) => void
  /** `changed`: the operator typed in this cell since it took the focus — only then is it written */
  onNav: (key: NavKey, draft: string, changed: boolean) => void
}

/** One cell: an auto-growing textarea that commits once (see the file header for the keys). */
function Cell({ k, kn, value, label, readOnly, time = false, placeholder, className, last = false, draftKey, onCommit, onNav }: CellProps) {
  const T0 = T()
  const [draft, setDraft] = useState(() => (draftKey ? readDraft<string | null>(draftKey, null) : null) ?? value)
  /** typed since the focus (or a kept draft came back): the one thing that makes a cell write */
  const dirty = useRef(draft !== value)
  /** the key handler already committed this draft — the blur that follows must not commit again */
  const handled = useRef(false)
  const [focused, setFocused] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // an untouched cell follows the stored value — a remote change shows up even while focused
  useEffect(() => { if (!dirty.current) setDraft(value) }, [value])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  const live = useRef({ draft, value, readOnly, onCommit })
  useEffect(() => { live.current = { draft, value, readOnly, onCommit } })
  /** write what was typed, if anything — or keep it on the device while the page is read-only */
  const flush = useCallback(() => {
    const l = live.current
    if (!dirty.current) return
    if (l.draft === l.value) { dirty.current = false; if (draftKey) clearDraft(draftKey); return }
    if (l.readOnly) { if (draftKey) keepDraft(draftKey, l.draft); return }
    dirty.current = false
    if (draftKey) clearDraft(draftKey)
    l.onCommit(l.draft)
  }, [draftKey])
  // …when the page goes away, the app is hidden, or the cell itself goes
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])
  // the Einsatz turned read-only under the typing (closed elsewhere): keep it; writable again: offer it
  useEffect(() => {
    if (!draftKey) return
    if (readOnly) { if (dirty.current) keepDraft(draftKey, live.current.draft); return }
    const kept = readDraft<string | null>(draftKey, null)
    if (kept != null && kept !== live.current.value) { dirty.current = true; setDraft(kept) }
  }, [readOnly, draftKey])
  const insertBreak = (el: HTMLTextAreaElement) => {
    const a = el.selectionStart, b = el.selectionEnd
    dirty.current = true
    setDraft((d) => `${d.slice(0, a)}\n${d.slice(b)}`)
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1 })
  }
  const nav = (key: NavKey) => {
    const changed = dirty.current && draft !== value
    handled.current = true
    dirty.current = false
    if (draftKey) clearDraft(draftKey)
    onNav(key, draft, changed)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // an IME still composing (Safari reports it as keyCode 229, isComposing false)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && e.altKey) {
      // Alt+Enter is a line break like Shift+Enter (Excel) — a textarea does not do it by itself
      e.preventDefault()
      insertBreak(e.currentTarget)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      nav('enter')
      return
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      nav(e.shiftKey ? 'shift-tab' : 'tab')
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (draft !== value) { setDraft(value); dirty.current = false; if (draftKey) clearDraft(draftKey) }
      else e.currentTarget.blur()
    }
  }
  // a soft keyboard has no Shift/Alt+Enter: on touch the focused cell offers the line break itself
  const coarse = useMediaQuery('(pointer: coarse)')
  const breakKey = coarse && focused && !readOnly
  return (
    <span className={s.cellWrap}>
      <textarea
        ref={ref}
        rows={1}
        className={cx(s.cell, time && s.time, breakKey && s.cellBreak, className)}
        value={draft}
        readOnly={readOnly}
        aria-label={label}
        placeholder={readOnly ? undefined : placeholder}
        data-k={k}
        data-kn={kn}
        // the phone's return key says what Enter does here: on to the next cell, or done
        enterKeyHint={last ? 'done' : 'next'}
        inputMode={time ? 'numeric' : undefined}
        spellCheck={!time}
        onPointerDown={keep}
        onFocus={() => { handled.current = false; setFocused(true) }}
        onChange={(e) => { handled.current = false; dirty.current = true; setDraft(e.target.value) }}
        onBlur={() => {
          setFocused(false)
          if (handled.current) { handled.current = false; return }
          flush()
        }}
        onKeyDown={onKeyDown}
      />
      {breakKey && !time && (
        // keeps the focus (and the keyboard) where it is: the press never reaches the textarea's blur
        <button type="button" className={s.breakKey} aria-label={T0.lineBreak} title={T0.lineBreak}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
          onClick={() => { if (ref.current) insertBreak(ref.current) }}>
          <span aria-hidden="true">↵</span>
        </button>
      )}
    </span>
  )
}

function TrendButton({ trend, readOnly, onNext }: { trend: string | undefined; readOnly: boolean; onNext: () => void }) {
  const t = T()
  const word = trend === 'up' ? t.trendUp : trend === 'same' ? t.trendSame : trend === 'down' ? t.trendDown : t.trendNone
  return (
    <IconButton label={fillTemplate(t.trendTitle, { trend: word })} disabled={readOnly} className={s.trend} data-trend={trend ?? 'none'}
      tabIndex={-1} onPointerDown={keep} onClick={onNext}>
      <span aria-hidden="true">{trend ? ARROW[trend] : '·'}</span>
    </IconButton>
  )
}

function DoneButton({ on, readOnly, onToggle }: { on: boolean; readOnly: boolean; onToggle: () => void }) {
  return (
    <IconButton label={T().done} aria-pressed={on} disabled={readOnly} className={cx(s.done, on && s.doneOn)} tabIndex={-1}
      onPointerDown={keep} onClick={onToggle}>
      {on ? <Icon id="check" /> : <span className={s.tick} aria-hidden="true" />}
    </IconButton>
  )
}

/** Focus the cell named `k` (a `data-k` or `data-kn`) once the render that creates it has landed —
 *  a key's target may be a row the very commit it triggered is making. */
function useFocusAfterRender(root: RefObject<HTMLElement | null>): (k: string) => void {
  const want = useRef<string | null>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    const k = want.current
    if (!k) return
    const el = root.current?.querySelector<HTMLTextAreaElement>(`[data-k="${CSS.escape(k)}"],[data-kn="${CSS.escape(k)}"]`)
    if (!el) return
    want.current = null
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  })
  return useCallback((k: string) => { want.current = k; bump() }, [])
}

export interface TafelFormPageProps {
  /** the page's anno id — the namespace of the drafts this device keeps for it */
  pageKey: string
  data: BoardFormData
  readOnly: boolean
  isPhone: boolean
  onChange: (next: BoardFormData) => void
  onRemove: () => void
  /** what the live mini Karte of a `map` section draws — it exists only while this page is shown */
  scene?: MiniKarteProps
  /** a tap on the mini Karte opens the Karte */
  onOpenKarte?: () => void
  /** px the floating chrome covers: top bar + page strip, the rails */
  inset: { top: number; left: number; right: number; bottom: number }
}

export function TafelFormPage({ pageKey, data, readOnly, isPhone, onChange, onRemove, scene, onOpenKarte, inset }: TafelFormPageProps) {
  const t = T()
  const page = data.page
  const sections = shownSections(page)
  const rootRef = useRef<HTMLDivElement>(null)

  // ── the trailing rows' ids: one per list, re-minted once the list has taken it ────────────
  // (React's «adjust state while rendering»: a list whose trailing id was taken by the commit
  // that just landed gets a fresh one, and the render repeats before anything is painted)
  const [pending, setPending] = useState<Record<string, string>>({})
  const minted: Record<string, string> = {}
  const trailing = (list: string, taken: readonly string[]): string => {
    const cur = pending[list]
    if (cur && !taken.includes(cur)) return cur
    minted[list] = newId('fr')
    return minted[list]
  }

  // ── the layout the keyboard moves through (lib/boardFormNav) ──────────────────────────────
  /** per section: the ids of what it shows top to bottom — a box's lines (an empty line above a
   *  written one included) and its empty line; a table's written area as one id per RULING, the
   *  written rows' own and a pre-minted one per empty ruling (keyed by the ruling, so the ruling
   *  typed into is the ruling the row is written on — lib/boardForm · slotted) */
  const ids: Record<string, { lines?: Record<string, { lines: string[]; newId: string }>; slots?: string[]; written?: number }> = {}
  const layout: NavSection[] = []
  if (page.header) layout.push({ kind: 'text', id: HEAD_SEC, fields: HEAD_KEYS })
  for (const sec of sections) {
    if (sec.type === 'quad') {
      const boxes = sec.cells.map((c) => {
        const laid = boxLines(data, sec.id, c.id)
        const taken = laid.flatMap((l) => (l ? [l.id] : []))
        const lines = laid.map((l, j) => l?.id ?? trailing(`${sec.id}/${c.id}#${j}`, taken))
        return { id: c.id, lines, newId: trailing(`${sec.id}/${c.id}`, taken) }
      })
      ids[sec.id] = { lines: Object.fromEntries(boxes.map((b) => [b.id, b])) }
      layout.push({ kind: 'quad', id: sec.id, boxes: readOnly ? [] : boxes, tag: !!sec.tag })
    } else if (sec.type === 'table') {
      const fixedRowIds = tableRows(data, sec).slice(0, shownFixedCount(sec)).map((r) => r.id)
      const laid = tableSlots(data, sec)
      const taken = laid.flatMap((r) => (r ? [r.id] : []))
      const adds = tableAddsRows(sec) && !readOnly
      // the ruled empty rows the paper has are LIVE rows (owner, round 2) — between the written
      // ones and below them, as many as the box holds (a pre-printed row stands two rulings
      // tall), and always one more than written. Each is its ruling: typed into, it is written
      // ON that ruling and stays there (owner, round 2: no jumping up to the first empty row).
      const room = adds && !isPhone ? Math.max(0, (sec.height ?? 0) - fixedRowIds.length * 2) : 0
      const count = adds ? Math.max(laid.length + 1, room) : laid.length
      const slots = Array.from({ length: count }, (_, j) => laid[j]?.id ?? trailing(`${sec.id}#${j}`, taken))
      ids[sec.id] = { slots, written: laid.length }
      const typed = (cs: TemplateColumn[]) => cs.filter((c) => c.type !== 'trend').map((c) => c.id)
      const fixed = (sec.fixedRows ?? []).map((r) => r.id)
      layout.push({
        kind: 'table', id: sec.id, cols: readOnly ? [] : typed(editableColumns(sec)),
        rows: [...fixedRowIds, ...slots.slice(0, laid.length)], adds,
        newId: adds ? slots[laid.length] : undefined, free: adds ? slots.slice(laid.length) : undefined,
        fixed, writtenCols: readOnly ? [] : typed(writtenColumns(sec)),
      })
    } else if (sec.type === 'text') {
      layout.push({ kind: 'text', id: sec.id, fields: readOnly ? [] : sec.fields.map((f) => f.id) })
    }
  }
  if (Object.keys(minted).length) setPending((p) => ({ ...p, ...minted }))
  const lastKey = (() => {
    const l = [...layout].reverse().find((x) => (x.kind === 'quad' ? x.boxes.length : x.kind === 'table' ? x.cols.length : x.fields.length))
    if (!l) return ''
    if (l.kind === 'text') return keyOf(l.id, undefined, undefined, l.fields[l.fields.length - 1])
    if (l.kind === 'table') {
      const cs = l.adds ? l.writtenCols ?? l.cols : l.cols
      const lastRow = l.adds ? (l.free ?? [])[(l.free ?? []).length - 1] ?? l.newId : l.rows[l.rows.length - 1]
      return keyOf(l.id, undefined, lastRow, cs[cs.length - 1])
    }
    const b = l.boxes[l.boxes.length - 1]
    return keyOf(l.id, b.id, b.newId, undefined)
  })()

  // ── writing ────────────────────────────────────────────────────────────────────────────────
  const put = (next: BoardFormData) => { if (next !== data) onChange(next) }
  const timeCol = (sec: TableSection) => editableColumns(sec).find((c) => c.type === 'time')
  /** the next state for a cell commit; `stamp` = Enter finished the row, so an empty «Wann» of a
   *  row with words gets the current time (one ↶ step with the commit, so ↶ takes it back) */
  const next = (a: Addr, raw: string, stamp: boolean): BoardFormData => {
    // every commit carries its time (server clock): what settles a cell two devices changed at once
    const at = serverNow()
    switch (a.kind) {
      case 'line': return putLine(data, a.sec, a.box, a.row, { text: raw, slot: a.slot }, at)
      case 'tag': return putLine(data, a.sec, a.box, a.row, { tag: raw }, at)
      case 'field': {
        const sec = sections.find((x) => x.id === a.sec) as TextSection | undefined
        const f = sec?.fields.find((x) => x.id === a.col)
        return putField(data, a.sec, a.col, f?.type === 'time' ? normalizeTime(raw) : raw, at)
      }
      case 'head': return putHead(data, a.col, a.col === 'alarm' ? normalizeTime(raw) : raw, at)
      case 'cell': {
        const sec = sections.find((x) => x.id === a.sec) as TableSection | undefined
        if (!sec) return data
        const col = sec.columns.find((c) => c.id === a.col)
        const cells: Record<string, string> = { [a.col]: col?.type === 'time' ? normalizeTime(raw) : raw }
        const tc = timeCol(sec)
        if (stamp && tc && tc.id !== a.col) {
          const row = tableRows(data, sec).find((r) => r.id === a.row)
          const merged = { ...row?.cells, ...cells }
          const words = writtenColumns(sec).some((c) => (c.type ?? 'text') === 'text' && (merged[c.id] ?? '').trim())
          if (words && !(merged[tc.id] ?? '').trim()) cells[tc.id] = hhmm(new Date(at))
        }
        return putRow(data, a.sec, a.row, { cells, slot: a.slot }, at)
      }
    }
  }
  /** does the line / row the cursor is in hold nothing once `draft` is committed? */
  const emptyAfter = (a: Addr, draft: string): boolean => {
    if (a.kind === 'line' || a.kind === 'tag') {
      const l = data.values[a.sec]?.lines?.[a.box]?.find((x) => x.id === a.row)
      const text = a.kind === 'line' ? draft : l?.text ?? ''
      const tag = a.kind === 'tag' ? draft : l?.tag ?? ''
      return !text.trim() && !tag.trim()
    }
    if (a.kind === 'cell') {
      const sec = sections.find((x) => x.id === a.sec) as TableSection | undefined
      if (!sec) return true
      const row = tableRows(data, sec).find((r) => r.id === a.row)
      const merged = { ...row?.cells, [a.col]: draft }
      const cs = (sec.fixedRows ?? []).some((r) => r.id === a.row) ? editableColumns(sec) : writtenColumns(sec)
      return !cs.some((c) => c.type !== 'trend' && (merged[c.id] ?? '').trim())
    }
    return false
  }

  // ── focus: where a key sent the cursor, resolved after the commit's render ───────────────────
  const focusAfterRender = useFocusAfterRender(rootRef)
  const onNav = (a: Addr, key: NavKey, draft: string, changed: boolean) => {
    const at = navAtOf(a)
    const target = navTarget(layout, at, key, emptyAfter(a, draft))
    // only what was typed is written: a cell passed through never overwrites another device's change
    if (changed) put(next(a, draft, key === 'enter'))
    if (target === null) return
    if (target === 'blur') { (document.activeElement as HTMLElement | null)?.blur(); return }
    focusAfterRender(keyOf(target.sec, target.box, target.row, target.col))
  }
  const commit = (a: Addr) => (v: string) => put(next(a, v, false))
  const draftKey = (k: string) => `tafel:${pageKey}:${k}`

  // ── sections ───────────────────────────────────────────────────────────────────────────────
  const ROW_PX = isPhone ? 44 : 40
  const minH = (h: number | undefined) => (h && !isPhone ? { minHeight: h * ROW_PX } : undefined)
  const heading = (title?: string, sub?: string) => (
    <>
      {title ? <h3 className={s.sh}>{title}</h3> : null}
      {sub ? <div className={s.sub}>{sub}</div> : null}
    </>
  )

  const quad = (sec: QuadSection) => {
    const st = minH(sec.height)
    return (
      <div className={cx(s.quad, sec.cells.length > 2 && !isPhone && s.quad2)} style={st}>
        {sec.cells.map((c) => {
          const laid = boxLines(data, sec.id, c.id)
          const box = ids[sec.id].lines![c.id]
          const label = labelText(c.label)
          /** `isNew`: an empty line (no trend, no Stichwort yet); `alias`: THE empty line at the end
           *  of the box — the one «the next empty line» resolves to (an empty line above a written
           *  one is not it) */
          const lineRow = (id: string, text: string, trend: string | undefined, tag: string | undefined, isNew: boolean, slot: number, alias = isNew) => {
            const a: Addr = { kind: 'line', sec: sec.id, box: c.id, row: id, slot }
            return (
              <div key={id} className={cx(s.line, isNew && s.lineNew)}>
                {sec.trend && (isNew ? <span className={s.trendGap} aria-hidden="true" />
                  : <TrendButton trend={trend} readOnly={readOnly} onNext={() => put(putLine(data, sec.id, c.id, id, { trend: nextTrend(trend) }, serverNow()))} />)}
                <Cell k={keyOf(sec.id, c.id, id, undefined)} kn={alias ? keyOf(sec.id, c.id, NEW, undefined) : undefined}
                  value={text} label={label} readOnly={readOnly} className={s.grow}
                  last={keyOf(sec.id, c.id, id, undefined) === lastKey}
                  onCommit={commit(a)} onNav={(key, d, ch) => onNav(a, key, d, ch)} draftKey={draftKey(keyOf(sec.id, c.id, id, undefined))} />
                {sec.tag && !isNew && (
                  <Cell k={`${keyOf(sec.id, c.id, id, 'tag')}`} value={tag ?? ''} label={`${label} · ${t.tag}`} placeholder={t.tag}
                    readOnly={readOnly} className={s.tag}
                    onCommit={commit({ kind: 'tag', sec: sec.id, box: c.id, row: id })} onNav={(key, d, ch) => onNav({ kind: 'tag', sec: sec.id, box: c.id, row: id }, key, d, ch)}
                    draftKey={draftKey(keyOf(sec.id, c.id, id, 'tag'))} />
                )}
              </div>
            )
          }
          return (
            <div key={c.id} className={s.box} data-box={c.id}
              // a tap on the empty part of a box writes into it (its empty line)
              onPointerDown={keep}
              onClick={(e) => { if (e.target === e.currentTarget) (e.currentTarget.querySelector<HTMLTextAreaElement>('[data-kn]'))?.focus() }}>
              <div className={s.boxLabel}>{label}</div>
              {/* by slot: an emptied line above a written one stays an (empty) line — nothing moves up */}
              {laid.map((l, j) => (l ? lineRow(l.id, l.text, l.trend, l.tag, false, j) : lineRow(box.lines[j], '', undefined, undefined, true, j, false)))}
              {!readOnly && lineRow(box.newId, '', undefined, undefined, true, laid.length)}
            </div>
          )
        })}
      </div>
    )
  }

  const table = (sec: TableSection) => {
    const cols = shownColumns(sec)
    const fixedRows = new Map((sec.fixedRows ?? []).map((r) => [r.id, r]))
    const fixedList = tableRows(data, sec).slice(0, shownFixedCount(sec))
    const laid = tableSlots(data, sec)
    const { slots = [], written = 0 } = ids[sec.id]
    const grid: CSSProperties = { gridTemplateColumns: [...cols.map((c) => `minmax(0, ${c.w ?? 1}fr)`), ...(sec.done ? ['auto'] : [])].join(' ') }
    /** `slot`: the ruling of a written-area row; `alias`: the first empty row after the written
     *  ones — what «the next empty row» (NEW) resolves to */
    const cellFor = (r: { id: string; cells: Record<string, string> }, c: TemplateColumn, isNew: boolean, slot?: number, alias = false) => {
      const label = labelText(c.label)
      const fixedRow = fixedRows.has(r.id)
      if (c.fixed && fixedRow) {
        const v = fixedRows.get(r.id)?.cells[c.id]
        if (c.type === 'symbol') return <span key={c.id} className={cx(s.td, s.sig)}><BoardSignature name={typeof v === 'string' ? v : labelText(v)} className={s.sigSvg} /></span>
        if (c.type === 'index') return <span key={c.id} className={cx(s.td, s.index)}><span className={s.disc}>{labelText(v)}</span></span>
        return <span key={c.id} className={cx(s.td, s.fixed)}>{labelText(v)}</span>
      }
      // a written row under a fixed list has no Signatur / number of its own — the rest it types
      if (c.fixed && (c.type === 'symbol' || c.type === 'index')) return <span key={c.id} className={s.td} />
      if (c.type === 'trend') {
        return (
          <span key={c.id} className={cx(s.td, s.trendCell)}>
            {!isNew && <TrendButton trend={r.cells[c.id]} readOnly={readOnly}
              onNext={() => put(putRow(data, sec.id, r.id, { cells: { [c.id]: nextTrend(r.cells[c.id]) ?? '' } }, serverNow()))} />}
          </span>
        )
      }
      const a: Addr = { kind: 'cell', sec: sec.id, row: r.id, col: c.id, slot }
      const k = keyOf(sec.id, undefined, r.id, c.id)
      return (
        <span key={c.id} className={s.td}>
          <Cell k={k} kn={alias ? keyOf(sec.id, undefined, NEW, c.id) : undefined}
            value={r.cells[c.id] ?? ''} label={label} readOnly={readOnly} time={c.type === 'time'}
            placeholder={c.type === 'time' ? '--:--' : undefined} last={k === lastKey}
            onCommit={commit(a)} onNav={(key, d, ch) => onNav(a, key, d, ch)} draftKey={draftKey(k)} />
        </span>
      )
    }
    return (
      <div className={s.table} role="table" aria-label={labelText(sec.title) || labelText(page.title)} style={minH(sec.height)}>
        <div className={cx(s.tr, s.thead)} role="row" style={grid}>
          {cols.map((c) => <span key={c.id} className={s.th} role="columnheader">{labelText(c.label)}</span>)}
          {sec.done && <span className={s.th} role="columnheader"><span className={s.srOnly}>{t.done}</span></span>}
        </div>
        {fixedList.map((r) => (
          <div key={r.id} className={cx(s.tr, s.trFixed, r.done && s.trDone)} role="row" style={grid}>
            {cols.map((c) => cellFor(r, c, false))}
            {sec.done && <span className={cx(s.td, s.doneCell)}>
              <DoneButton on={!!r.done} readOnly={readOnly} onToggle={() => put(putRow(data, sec.id, r.id, { done: !r.done }, serverNow()))} />
            </span>}
          </div>
        ))}
        {/* the written area, ruling by ruling: a written row stays on the ruling it was written on,
            an empty ruling above it stays an empty (live) row — lib/boardForm · slotted */}
        {slots.map((id, j) => {
          const r = laid[j]
          if (!r) {
            return (
              <div key={id} className={cx(s.tr, s.trNew)} role="row" style={grid}>
                {cols.map((c) => cellFor({ id, cells: {} }, c, true, j, j === written))}
                {sec.done && <span className={s.td} />}
              </div>
            )
          }
          return (
            <div key={r.id} className={cx(s.tr, r.done && s.trDone)} role="row" style={grid}>
              {cols.map((c) => cellFor(r, c, false, j))}
              {sec.done && <span className={cx(s.td, s.doneCell)}>
                <DoneButton on={!!r.done} readOnly={readOnly} onToggle={() => put(putRow(data, sec.id, r.id, { done: !r.done }, serverNow()))} />
              </span>}
            </div>
          )
        })}
      </div>
    )
  }

  const text = (sec: TextSection) => {
    const layoutKind = sec.layout ?? (sec.fields.length > 1 ? 'row' : 'stack')
    const v = data.values[sec.id]?.fields ?? {}
    const st = minH(sec.height)
    const field = (f: TextSection['fields'][number], i: number) => {
      const a: Addr = { kind: 'field', sec: sec.id, col: f.id }
      const label = labelText(f.label) || labelText(sec.title)
      const k = keyOf(sec.id, undefined, undefined, f.id)
      return (
        <label key={f.id} className={cx(s.field, f.tone && s[`tone_${f.tone}`], layoutKind === 'split' && i === 0 && s.fieldMain)}>
          {(i === 0 && sec.title) || f.label ? <span className={s.fieldLabel}>{i === 0 && sec.title && !f.label ? labelText(sec.title) : labelText(f.label)}</span> : null}
          <Cell k={k} value={v[f.id] ?? ''} label={label} readOnly={readOnly} time={f.type === 'time'} className={s.fieldCell}
            last={k === lastKey} onCommit={commit(a)} onNav={(key, d, ch) => onNav(a, key, d, ch)} draftKey={draftKey(k)} />
        </label>
      )
    }
    if (layoutKind === 'split') {
      return (
        <div className={cx(s.textBox, s.split)} style={st}>
          {field(sec.fields[0], 0)}
          <div className={s.splitRow}>{sec.fields.slice(1).map((f, i) => field(f, i + 1))}</div>
        </div>
      )
    }
    return <div className={cx(s.textBox, layoutKind === 'row' && !isPhone && s.textRow)} style={st}>{sec.fields.map(field)}</div>
  }

  const map = (sec: { height?: number }) => (
    <div className={s.map} style={minH(sec.height)}>
      {/* inert: the markers inside are buttons on the Karte — here they are a picture, and neither
          Tab nor the iOS ↑↓ bar may stop on them */}
      <div className={cx(s.mapInner, 'tfp-map')} inert>{scene && <MiniKarte {...scene} />}</div>
      <button type="button" className={s.mapOpen} aria-label={t.mapLabel} title={t.mapPrint}
        onPointerDown={keep} onClick={() => onOpenKarte?.()}>
        <span className={s.mapChip}><Icon id="map" />{t.mapOpen}</span>
      </button>
    </div>
  )

  const cols = isPhone ? 1 : page.columns ?? 1
  return (
    <div ref={rootRef} className={cx(s.page, isPhone && s.phone)} data-testid="tafel-page" data-page={page.id}
      // the deployment's language: what the cells hyphenate by (`hyphens: auto`, TafelFormPage.module.css)
      lang={getLocaleId()}
      style={{ paddingTop: inset.top, paddingLeft: inset.left, paddingRight: inset.right, paddingBottom: inset.bottom }}>
      <div className={cx(s.paper, page.paper === 'landscape' && s.landscape, cols === 1 && s.single)}>
        <header className={s.head}>
          <h2 className={s.title}>{labelText(page.title)}</h2>
          <span className={s.meta} title={t.keysHint}>{fillTemplate(t.template, { title: labelText(data.tpl.title), v: data.tpl.version })}</span>
          {!readOnly && (
            <IconButton label={t.removePage} className={s.remove} onPointerDown={keep} onClick={onRemove}><Icon id="trash" /></IconButton>
          )}
        </header>
        {page.header && (
          <div className={s.headRow}>
            {HEAD_KEYS.map((k) => {
              const a: Addr = { kind: 'head', col: k }
              return (
                <label key={k} className={cx(s.field, s.headField)}>
                  <span className={s.fieldLabel}>{t.head[k]}</span>
                  <Cell k={keyOf(HEAD_SEC, undefined, undefined, k)} value={data.head?.[k] ?? ''} label={t.head[k]} readOnly={readOnly} time={k === 'alarm'}
                    className={s.fieldCell} onCommit={commit(a)} onNav={(key, d, ch) => onNav(a, key, d, ch)} draftKey={draftKey(keyOf(HEAD_SEC, undefined, undefined, k))} />
                </label>
              )
            })}
          </div>
        )}
        <div className={s.grid} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {sections.map((sec) => (
            <section key={sec.id} className={cx(s.sec, sec.type === 'text' && s.secText)} data-sec={sec.id}
              style={{ gridColumn: cols > 1 && sec.span === 2 ? '1 / -1' : undefined }}>
              {sec.type !== 'text' && heading(labelText(sec.title), labelText(sec.subtitle))}
              {sec.type === 'quad' ? quad(sec) : sec.type === 'table' ? table(sec) : sec.type === 'text' ? text(sec) : map(sec)}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
