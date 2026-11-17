import { useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { shownTeamColor } from '../lib/teamColors'
import { cx } from '../lib/cx'
import { TruppNo } from './TruppNo'
import { SearchField } from './SearchField'
import { ListCard, ListRow } from './ListRow'
import { EmptyState } from './EmptyState'
import { fillTemplate } from '../lib/format'
import { Overlay } from '../lib/overlays'
import { searchQuery } from '../lib/search'
import { truppMatches, type PlacedTrupp } from '../lib/placedTrupps'
import { isAtemschutzTrupp } from '../lib/atemschutz'
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
 * this overlay was opened by tapping «Trupp finden». Typing is what was meant.
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
        {/* the head IS the search — THE search field in its one documented modifier (`head`), wearing
            the door's own glyph (#trupp-find, 29.09.2026 T8): the card says it is the one that was tapped.
            No inner ✕ (`noClear`, 29.09.2026): the finder IS the search, so its close ✕ ends it */}
        <SearchField
          ref={inputRef} variant="head" icon="trupp-find" value={q} placeholder={C.placeholder} aria-label={C.title} noClear
          onChange={(v) => { setQ(v); setCursor(0) }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className={`ip-x ${s.x}`} onClick={onClose} aria-label={appConfig.copy.closeDialog}>
          <Icon id="close" />
        </button>
      </div>

      {trupps.length === 0 ? (
        // nothing placed anywhere: say so, and say where a Trupp comes from — an empty list
        // reads as a broken search
        <EmptyState icon="trupp-find" title={C.empty} sub={C.emptyHint} />
      ) : (
        // THE list row (ListRow, LISTS.8): the cap · name + number · where · crew · tags · ›. The
        // keyboard cursor wears the row's hover wash – the pointer moves that same cursor
        // (onMouseEnter) instead of painting a second state; a Trupp «raus» recedes like every
        // done thing (`--done-opacity`), it is not recoloured
        <ListCard look="rail" className={s.list} role="listbox" aria-label={C.title}>
          {hits.map((t, i) => (
            <ListRow
              key={t.key} role="option" aria-selected={i === cursor}
              className={cx(i === cursor && s.rowOn, t.status === 'raus' && s.rowRaus)}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(t)}
              // the colour this Trupp wears out there — the same cap the plan chip and the map
              // dot carry, so the row and the marker read as one thing
              lead={<span className={s.cap} style={{ background: shownTeamColor(t.color) }} />}
              title={<>{t.name}<TruppNo no={t.no} /></>}
              // WHERE first, then who ELSE is in it: the question this list answers is where.
              // ⚠️ `members` leads with the leader (the search needs him), and the row's name
              // already is him — printed again he took half the line and cut off the crew
              // member you were actually looking for (29.09.2026, sweep 3 T7).
              sub={<>{t.where}{t.members.length > 1 && ` · ${t.members.slice(1).join(' / ')}`}</>}
              // «AS» — this crew is under Presslufatmer: a fact, not an alarm, THE neutral tag like
              // «raus» beside it. ⚠️ Only for a chip that HAS a Trupp: `isAtemschutzTrupp` reads an
              // absent `kind` as «unter Atemschutz», which on a loose «Team 2» marker is a claim
              // nobody made.
              end={(!!t.truppId && isAtemschutzTrupp(t)) || t.status === 'raus' ? (
                <span className={s.tags}>
                  {!!t.truppId && isAtemschutzTrupp(t) && (
                    <span className="ip-badge ip-badge-arch" title={appConfig.copy.atemschutz.kindAtemschutz}>{appConfig.copy.atemschutz.asMark}</span>
                  )}
                  {t.status === 'raus' && <span className="ip-badge ip-badge-arch">{C.raus}</span>}
                </span>
              ) : undefined}
            />
          ))}
          {hits.length === 0 && <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q: q.trim() })}</p>}
        </ListCard>
      )}

      {/* only the count, and only while filtering (29.09.2026, T7): the «Sucht auch nach Namen»
          hint said what the placeholder «Trupp oder Name …» above it already says */}
      {trupps.length > 0 && hits.length !== trupps.length && <div className={s.foot}>{`${hits.length}/${trupps.length}`}</div>}
    </Overlay>
  )
}
