import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SymbolsApi } from '../lib/useSymbols'
import type { ShapeKind } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { formatSymbolName } from '../lib/format'
import { symbolMatchesQuery } from '../lib/symbolSearch'
import { FORMEN_ORDER, SHAPE_DEFS, ShapeGlyph } from '../lib/shapes'

// the geometric "Formen" section renders right after this FireGIS category; Rauch (cloud)
// is offered inside the Schadenlage category instead of the Formen block.
const FORMEN_AFTER_CAT = 'Gefahren'
const RAUCH_IN_CAT = 'Schadenlage'

function ShapeCell({ kind, onPick }: { kind: ShapeKind; onPick: (k: ShapeKind) => void }) {
  return (
    <button className="sym-cell" title={appConfig.copy.shapes.names[kind]} onClick={() => onPick(kind)} draggable={false}>
      <span className="sym-shape"><ShapeGlyph kind={kind} color={SHAPE_DEFS[kind].defaultColor} /></span>
      <small>{appConfig.copy.shapes.names[kind]}</small>
    </button>
  )
}

interface Props {
  sym: SymbolsApi
  onPick: (name: string) => void
  onClose: () => void
  /** when provided, a "Formen" section lets the user place editable shapes */
  onPickShape?: (kind: ShapeKind) => void
}

function Cell({ name, svg, onPick }: { name: string; svg: string; onPick: (n: string) => void }) {
  return (
    <button className="sym-cell" title={name} onClick={() => onPick(name)} draggable={false}>
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <small>{formatSymbolName(name) || name}</small>
    </button>
  )
}

// Centred symbol-search modal — no tabs; all signs shown, grouped, scrollable.
export function Palette({ sym, onPick, onClose, onPickShape }: Props) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // the search is NOT autofocused — opening the palette shouldn't grab the keyboard
  // (or pop the on-screen keyboard on touch). The user clicks the field to type, or
  // just taps a symbol. Identical on both surfaces (Lage + Plan share this palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // keep Tab focus inside the dialog
  const trapFocus = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (!focusable || !focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  const query = q.trim().toLowerCase()
  // full synonym search — raw key, display label, copy.symbolAliases, and category heading
  // all match (umlaut-tolerant), see lib/symbolSearch.ts
  const matches = useMemo(
    () => (query ? sym.symbols.filter((s) => symbolMatchesQuery(s, query)) : []),
    [query, sym],
  )
  // portal to <body> so the backdrop escapes the .surface stacking context (z-index 20) and
  // covers the left NavRail (z-index 35) instead of rendering beneath it
  return createPortal((
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="sym-modal"
        role="dialog"
        aria-modal="true"
        aria-label={appConfig.copy.symbolSearchPlaceholder}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <div className="sym-top">
          <label className="sym-search">
            <Icon id="search" />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${appConfig.copy.symbolSearchPlaceholder} (${sym.symbols.length})`} />
            {q && <button className="sym-clear" onClick={() => setQ('')} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>}
          </label>
          <button className="sym-close" onClick={onClose} title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>

        <div className="sym-scroll">
          {query ? (
            matches.length === 0
              ? <div className="sym-empty">{appConfig.copy.noSymbolMatches}</div>
              : <div className="sym-grid">{matches.map((s) => <Cell key={s.name} name={s.name} svg={s.svg} onPick={onPick} />)}</div>
          ) : (
            <>
              {sym.order.map((cat) => (
                <Fragment key={cat}>
                  <section>
                    <div className="sym-ghead">{appConfig.copy.symbolCategories[cat] ?? cat}</div>
                    <div className="sym-grid">
                      {/* Rauch lives under Schadenlage (it's a damage picture, not a generic Form) */}
                      {onPickShape && cat === RAUCH_IN_CAT && <ShapeCell kind="cloud" onPick={onPickShape} />}
                      {sym.symbols.filter((s) => s.cat === cat).map((s) => <Cell key={s.name} name={s.name} svg={s.svg} onPick={onPick} />)}
                    </div>
                  </section>
                  {/* the geometric Formen (Pfeil · Rechteck) sit between Gefahren and Führung */}
                  {onPickShape && cat === FORMEN_AFTER_CAT && (
                    <section>
                      <div className="sym-ghead">{appConfig.copy.shapes.sectionTitle}</div>
                      <div className="sym-grid">
                        {FORMEN_ORDER.map((kind) => <ShapeCell key={kind} kind={kind} onPick={onPickShape} />)}
                      </div>
                    </section>
                  )}
                </Fragment>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  ), document.body)
}
