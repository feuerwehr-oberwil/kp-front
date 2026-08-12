import { useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { Overlay } from '../lib/overlays'
import { searchQuery } from '../lib/search'
import { truppMatches, type PlacedTrupp } from '../lib/placedTrupps'
import s from './TruppFinder.module.css'

/**
 * «Wo steht Trupp 2?» — one list, every placed Trupp on it, tap to go there.
 *
 * Deliberately the same shape as the «Welcher Trupp?» card the map already opens: a short list
 * of rows you tap, over whatever you were doing, gone the moment you have chosen. It is NOT a
 * surface — a Trupp is looked for in the middle of something else, and a surface would take the
 * Lage away to show a list ABOUT the Lage.
 *
 * The search box is the one control here that opens a keyboard, and it is focused on open:
 * unlike the roster pickers (where the list itself is the answer and a keyboard would cover it),
 * this overlay was opened by tapping a magnifying glass. Typing is what was meant.
 */
export function TruppFinder({ trupps, onPick, onClose }: {
  /** every placed Trupp, already sorted (lib/placedTrupps) */
  trupps: PlacedTrupp[]
  onPick: (t: PlacedTrupp) => void
  onClose: () => void
}) {
  const C = appConfig.copy.truppFinder
  const [q, setQ] = useState('')
  // the row Enter would take — moved with ↑/↓, reset by every keystroke (the first hit of the
  // narrowed list is always the one meant)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const hits = useMemo(() => {
    const needle = searchQuery(q)
    return needle ? trupps.filter((t) => truppMatches(t, needle)) : trupps
  }, [trupps, q])

  const pick = (t: PlacedTrupp | undefined) => { if (t) { onPick(t); onClose() } }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[cursor]) }
  }

  return (
    <Overlay open onClose={onClose} className={cx(s.finder, 'ui-dialog')} ariaLabel={C.title} initialFocus={inputRef}>
      <div className={s.head}>
        <span className={s.headIcon} aria-hidden><Icon id="search" /></span>
        <input
          ref={inputRef} className={s.input} value={q} placeholder={C.placeholder} aria-label={C.title}
          onChange={(e) => { setQ(e.target.value); setCursor(0) }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className={s.x} onClick={onClose} aria-label={appConfig.copy.closeDialog}>
          <Icon id="close" />
        </button>
      </div>

      {trupps.length === 0 ? (
        // nothing placed anywhere: say so, and say where a Trupp comes from — an empty list
        // reads as a broken search
        <div className={s.empty}>
          <p>{C.empty}</p>
          <span>{C.emptyHint}</span>
        </div>
      ) : (
        <ul className={s.list} role="listbox" aria-label={C.title}>
          {hits.map((t, i) => (
            <li key={t.key}>
              <button
                type="button" role="option" aria-selected={i === cursor}
                className={cx(s.row, i === cursor && s.rowOn, t.status === 'raus' && s.rowRaus)}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(t)}
              >
                {/* the colour this Trupp wears out there — the same cap the plan chip and the
                    map dot carry, so the row and the marker read as one thing */}
                <span className={s.cap} style={{ background: t.color || appConfig.drawing.teamColors[0] }} />
                <span className={s.main}>
                  <span className={s.name}>{t.name}</span>
                  {/* WHERE first, then who is in it: the question this list answers is where */}
                  <span className={s.where}>
                    {t.where}
                    {t.members.length > 0 && <span className={s.members}> · {t.members.join(', ')}</span>}
                  </span>
                </span>
                {t.status === 'raus' && <span className={s.chip}>{C.raus}</span>}
                <span className={s.go} aria-hidden><Icon id="chevron" /></span>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className={s.none}>{C.noMatches}</li>}
        </ul>
      )}

      {trupps.length > 0 && <div className={s.foot}>{hits.length === trupps.length ? C.hint : `${hits.length}/${trupps.length}`}</div>}
    </Overlay>
  )
}
