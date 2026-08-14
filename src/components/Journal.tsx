import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanDocument, TimelineEvent } from '../types'
import { linkParts, type JournalLink } from '../lib/journalLinks'
import { Icon } from '../lib/icons'
import { EmptyState } from './EmptyState'
import { Overlay } from '../lib/overlays'
import { openPhoto } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import { dueClock, formatTime } from '../lib/format'
import { groupByDay, isNachtrag, rowPhotos, rowTime } from '../lib/verlauf'
import type { OpenReminder } from '../lib/reminders'

// One <audio> for the whole drawer: play toggles, a second tap pauses, and the row that
// is sounding shows a pause icon + a "playing" pulse so it's obvious what's playing.
function useAudioPlayer() {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => { ref.current?.pause(); ref.current = null }, [])
  const toggle = (id: string, url: string) => {
    if (playing === id && ref.current) { ref.current.pause(); setPlaying(null); return }
    ref.current?.pause()
    const a = new Audio(url)
    ref.current = a
    a.onended = () => setPlaying((p) => (p === id ? null : p))
    a.onpause = () => setPlaying((p) => (p === id ? null : p))
    void a.play().then(() => setPlaying(id)).catch(() => setPlaying(null))
  }
  return { playing, toggle }
}

/** Breathing room, in px, at each end of the activity strip. THE source of truth for it: the
 *  track is inset by this and the tap→time maths subtracts it, so the two cannot drift apart
 *  and leave a tap landing a few minutes off what the ticks show. */
const STRIP_INSET = 10

// A row is clickable only when it carries a real jump target: a map entity, a
// pinned map point, or a plan point. Plain log lines (undo/redo, deletions,
// surface-only journal notes) are read-only — the journal is a record, not a UI.
const targetOf = (e: TimelineEvent): 'map-entity' | 'map-pin' | 'plan' | null => {
  if (e.entityId) return 'map-entity'
  if (e.coord) return 'map-pin'
  if (e.surface === 'plan' && e.planId && e.px != null && e.py != null) return 'plan'
  return null
}

// Short surface chip: "Lage" for the map, the plan's code (e.g. "Modul 1") for
// the plan so a glance tells you where each event happened.
const chip = (e: TimelineEvent, plans: PlanDocument[]): string => {
  const C = appConfig.copy.journal // read at call time so the resolved locale applies
  if (e.surface !== 'plan') return C.surfaceMap
  return plans.find((p) => p.id === e.planId)?.code ?? C.surfacePlan
}

// The unified Verlauf — the single, append-only stream of everything that
// happens on either surface. Rendered as a slide-over so it can open over the
// map or the plan; a row jumps back to wherever its event happened.
export function Journal({ events, plans, closedAt, vocab = [], onSelect, onClose, onTranscript, onReplay, openReminders, onReminderDone, mediaStatusOf, onOpenPlayer, onEditText, replayAtMs, onSeekTo, landOn }: {
  events: TimelineEvent[]
  plans: PlanDocument[]
  /** the linkable vocabulary (lib/journalLinks) — the SAME memo the composer marks with, so a
   *  name that lit up while it was being typed still lights up once it is a row */
  vocab?: JournalLink[]
  /** the Einsatzende (incident closed_at) — rows appended after it render as Nachträge */
  closedAt?: string | null
  onSelect: (e: TimelineEvent) => void
  onClose: () => void
  onTranscript?: (id: string, transcript: string) => void
  /** start time-travel replay from the Verlauf (closes the drawer). Absent while
   *  replay is already running. */
  onReplay?: () => void
  /** still-open reminders (by derived state) — lets a `created` row show its due time
   *  and a checklist-style done toggle. Absent ⇒ reminder rows render as plain log lines. */
  openReminders?: OpenReminder[]
  /** mark a reminder done preemptively from its Verlauf row (appends a done event). */
  onReminderDone?: (r: OpenReminder) => void
  /** offline-queue status of a row's media (photo/audio not yet on the server), or undefined
   *  once uploaded — drives the "wird geladen"/"nicht geladen" chip on media rows. */
  mediaStatusOf?: (rowId: string) => 'pending' | 'failed' | undefined
  /** open the Durchhören player sheet for a long recording (rows with audioMeta);
   *  seekSec jumps straight to a moment inside it (annotation rows link back) */
  onOpenPlayer?: (e: TimelineEvent, seekSec?: number) => void
  /** correct an annotation row's text (append-only textEdit patch — same pattern as the
   *  transcript edit; offered on rows inside a recording's window) */
  onEditText?: (id: string, text: string) => void
  /**
   * The replay playhead. Set ⇒ this Verlauf is being read alongside a Wiedergabe: rows after
   * this instant are the FUTURE and render dimmed, and the row the playhead stands in is marked.
   * ⚠️ It is not a live clock — it only changes when the playhead crosses a row (ReplayBar ·
   * onPlayhead), so this list does not re-render on every playback frame.
   */
  replayAtMs?: number | null
  /** during replay a row sets the MOMENT rather than flying to a place — the whole picture then
   *  reads as it did when the line was written, which is the question a pin only half answered */
  onSeekTo?: (e: TimelineEvent) => void
  /** scroll to one row and flash it when the drawer opens onto it (the Wiedergabe caption's
   *  «im Verlauf»). `nonce` so the same row twice in a row still lands. */
  landOn?: { id: string; nonce: number } | null
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.journal
  const audio = useAudioPlayer()
  // open reminders keyed by id, plus a clock captured when the drawer opens (it remounts on
  // each open, so this is "now" at open time) to flag overdue rows
  const openMap = new Map((openReminders ?? []).map((r) => [r.id, r]))
  const [now] = useState(() => Date.now())
  const [editTx, setEditTx] = useState<{ id: string; value: string } | null>(null)
  const saveTranscript = () => {
    if (!editTx) return
    onTranscript?.(editTx.id, editTx.value)
    setEditTx(null)
  }
  // text correction on an annotation row (same UI pattern as the transcript edit above)
  const [editRow, setEditRow] = useState<{ id: string; value: string } | null>(null)
  const saveRowText = () => {
    if (!editRow) return
    const v = editRow.value.trim()
    if (v) onEditText?.(editRow.id, v)
    setEditRow(null)
  }
  // recordings as windows on the incident timeline: a row whose time falls inside one is
  // an annotation of that recording and links back into the player at its moment
  const audioWindows = useMemo(() => events
    .filter((e) => e.audioUrl && e.audioMeta?.startedAt && (e.audioMeta.durationSec ?? 0) > 0)
    .map((e) => {
      const start = Date.parse(e.audioMeta!.startedAt)
      return { row: e, start, end: start + (e.audioMeta!.durationSec ?? 0) * 1000 }
    })
    .filter((w) => !Number.isNaN(w.start)), [events])

  // The strip's own state: the incident's time span, one tick per dated row, and the jump.
  // Rows WITHOUT an absolute time (legacy HH:MM-only entries) are simply not on it — a tick at a
  // guessed position would send the operator to the wrong place, which is worse than no tick.
  const listRef = useRef<HTMLDivElement>(null)
  const strideRef = useRef(0)
  const stripTicks = useMemo(
    () => events.map((e) => (e.at ? Date.parse(e.at) : NaN)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b),
    [events],
  )
  const stripSpan = useMemo(() => {
    if (stripTicks.length < 2) return null // one moment is not a timeline
    const from = stripTicks[0]
    const to = stripTicks[stripTicks.length - 1]
    return to > from ? { from, to } : null
  }, [stripTicks])
  /** Scroll the list to the row nearest a moment on the strip. */
  const jumpTo = (ms: number) => {
    let best: string | null = null
    let bestD = Infinity
    for (const e of events) {
      if (!e.at) continue
      const d = Math.abs(Date.parse(e.at) - ms)
      if (d < bestD) { bestD = d; best = e.id }
    }
    if (!best) return
    jumpToRow(best)
  }
  /** The row element for an id. ⚠️ Matched on `dataset`, not through a `[data-ev="…"]` selector:
   *  that needs `CSS.escape` for ids it cannot predict, and reaching for a global that does not
   *  exist everywhere (jsdom has no `CSS`) threw inside a requestAnimationFrame, where nothing
   *  catches it. A row id is data; walking the rows is cheap and cannot be mis-escaped. */
  const findRow = (id: string) => {
    const list = listRef.current
    if (!list) return null
    for (const el of list.querySelectorAll<HTMLElement>('[data-ev]')) if (el.dataset.ev === id) return el
    return null
  }
  /** How far the row is from the middle of the list, in px. 0 = centred. */
  const offCentre = (list: HTMLElement, el: HTMLElement) => {
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    return (er.top - lr.top) - (lr.height - er.height) / 2
  }
  /**
   * Scroll to one row by id and flash it — the strip, the pinned Erinnerungen and the
   * Wiedergabe's «im Verlauf» all share it. Returns whether the row was there to scroll to.
   *
   * ⚠️ The list is scrolled by a MEASURED delta first, and `scrollIntoView` is only the fallback.
   * That call walks up to whatever it decides is the scroll parent and animates it, and here it
   * is asked to do so on a drawer that is still animating open — so it scrolled the wrong box or
   * was undone by the layout that followed, and the Verlauf opened at the top with the row
   * nowhere in sight. Two rects and one assignment cannot pick the wrong container; but if the
   * assignment provably did not move the list (a scroll container this code did not expect),
   * the platform's own method still gets its turn rather than leaving the operator stranded.
   */
  const jumpToRow = (id: string) => {
    const list = listRef.current
    const el = findRow(id)
    if (!list || !el) return false
    // ⚠️ removed + reflowed + re-added, so landing on the SAME row twice runs the ring again;
    // an animation that is already on the element does not restart by itself (the Rapport's
    // jumpToStep does the same for its chips)
    el.classList.remove('jr-flash')
    void el.offsetWidth
    el.classList.add('jr-flash')
    window.setTimeout(() => el.classList.remove('jr-flash'), 2000)
    const lr = list.getBoundingClientRect()
    // before layout (jsdom, or a frame too early) every rect is 0 — the flash above is what says
    // «this is the one» either way
    if (lr.height <= 0) return true
    const before = list.scrollTop
    const delta = offCentre(list, el)
    list.scrollTop += delta
    // it should have moved. If it did not, this list is not the box that scrolls.
    if (Math.abs(delta) > 2 && list.scrollTop === before) el.scrollIntoView({ block: 'center' })
    return true
  }
  /**
   * Opened ONTO one row — «im Verlauf» on the Wiedergabe caption.
   *
   * Three things have to go right, and each of them bit:
   *   · LAYOUT — the drawer mounts on the same click that asks it to land, so for the first
   *     frames the row exists while the list has no box, and a delta computed from two
   *     zero-height rects moves nothing. So: wait for the list to have a height.
   *   · SETTLING — web fonts swap, media chips arrive, transcripts render. Every one of them
   *     changes the height of rows ABOVE the target, which slides it back out of the middle
   *     after a correct scroll. So: keep correcting for a few hundred ms until it holds still.
   *   · THE OPERATOR — who may start scrolling in the middle of all that, and must win. Any
   *     touch, wheel or drag on the list ends the settling immediately.
   *
   * ⚠️ NO «already landed» ref guard. There was one, and under <StrictMode> — which this app
   * mounts in — it made the whole thing dead code in development: React runs an effect, its
   * cleanup, then the effect again, so the first run recorded the nonce, the cleanup cancelled
   * its frame, and the second run saw its own nonce and returned. Nothing ever scrolled. The
   * dependency is the whole guard that is needed: `landOn` is state, so its identity changes
   * exactly when a new landing is requested.
   */
  useEffect(() => {
    if (!landOn) return
    let raf = 0
    let tries = 0
    let stable = 0
    let cancelled = false
    const stop = () => { cancelled = true }
    const list0 = listRef.current
    list0?.addEventListener('wheel', stop, { passive: true })
    list0?.addEventListener('touchstart', stop, { passive: true })
    list0?.addEventListener('pointerdown', stop)

    const settle = () => {
      if (cancelled) return
      const list = listRef.current
      const el = findRow(landOn.id)
      if (!list || !el || list.getBoundingClientRect().height <= 0) return
      const delta = offCentre(list, el)
      if (Math.abs(delta) > 2) { list.scrollTop += delta; stable = 0 } else stable += 1
      // three quiet frames, or ~40 frames of trying — whichever comes first
      if (stable < 3 && ++tries < 40) raf = requestAnimationFrame(settle)
    }
    const attempt = () => {
      if (cancelled) return
      const list = listRef.current
      const el = findRow(landOn.id)
      const laidOut = !!list && !!el && list.getBoundingClientRect().height > 0
      if (laidOut || ++tries > 20) {
        if (el) { jumpToRow(landOn.id); tries = 0; raf = requestAnimationFrame(settle) }
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    // fonts land late and re-flow every row above the target — one more correction when they do
    document.fonts?.ready.then(() => { if (!cancelled) settle() }).catch(() => {})
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      list0?.removeEventListener('wheel', stop)
      list0?.removeEventListener('touchstart', stop)
      list0?.removeEventListener('pointerdown', stop)
    }
  }, [landOn])

  // Overdue first, then by Fälligkeit — the same order the Atemschutz board sorts its cards in:
  // the one that has been waiting longest is the one that is about to be forgotten.
  const pinnedReminders = useMemo(
    () => [...(openReminders ?? [])].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    [openReminders],
  )

  return (
    <Overlay open onClose={onClose} className="journal-drawer" backdropClassName="journal-scrim" ariaLabel={C.title} dismissEscape={false}>
        <div className="journal-head">
          <span className="journal-title"><Icon id="history" />{C.title} · {events.length}</span>
          {onReplay && (
            <button className="journal-replay" onClick={onReplay} title={C.replayHint}>
              <Icon id="play" /><span>{C.replay}</span>
            </button>
          )}
          <button className="journal-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
        </div>
        {/* WHEN the Einsatz has substance, as one strip. A long Verlauf is a wall of rows in
            which «was war um halb zehn» means scrolling and reading — the strip answers it by
            position instead, and a tap on it lands on the nearest row. Ticks are not targets
            (the strip takes the tap as a whole), so nothing here needs a gloved-finger hit box. */}
        {stripSpan && (
          <div
            className="jr-strip" role="slider" tabIndex={0}
            aria-label={C.stripLabel}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}
            onPointerDown={(ev) => {
              // …against the TRACK, not the strip: the ticks are inset by STRIP_INSET, so a tap
              // on the strip's rounded end has to land on the first tick and not somewhere
              // before it. Same inset on both, from the one constant.
              const box = ev.currentTarget.getBoundingClientRect()
              const span = Math.max(1, box.width - STRIP_INSET * 2)
              const frac = Math.min(1, Math.max(0, (ev.clientX - box.left - STRIP_INSET) / span))
              jumpTo(stripSpan.from + frac * (stripSpan.to - stripSpan.from))
            }}
            onKeyDown={(ev) => {
              const step = (stripSpan.to - stripSpan.from) / 20
              if (ev.key === 'ArrowRight') { ev.preventDefault(); jumpTo(stripSpan.from + step * ++strideRef.current) }
              if (ev.key === 'ArrowLeft') { ev.preventDefault(); jumpTo(stripSpan.from + step * --strideRef.current) }
            }}
          >
            {/* the ticks live on an INSET track. Positioned against the strip itself, the first
                and last tick sat on its rounded ends — half-swallowed by the corner radius and
                the inset hairline, so the two moments that bracket the whole Einsatz were the
                two you could not see. */}
            <div className="jr-strip-track" style={{ insetInline: STRIP_INSET }}>
              {stripTicks.map((t, i) => (
                <i key={i} style={{ left: `${((t - stripSpan.from) / (stripSpan.to - stripSpan.from)) * 100}%` }} />
              ))}
            </div>
          </div>
        )}
        <div className="history-list" ref={listRef}>
          {events.length === 0 && <EmptyState icon="history" title={C.empty} />}
          {/* OFFENE ERINNERUNGEN, held at the top. The only rows in this list that are not where
              they happened — deliberately: a Wiedervorlage is about what still has to be done,
              and on an Einsatz that writes a row a minute it was scrolled past within ten. Each
              one jumps to its own place in the chronology, which is where the record keeps it. */}
          {pinnedReminders.length > 0 && (
            <div className="jr-pinned">
              <div className="jr-pinned-head">
                <Icon id="clock" /><span>{C.openRemindersHead}</span>
                <b>{C.openCount.replace('{n}', String(pinnedReminders.length))}</b>
              </div>
              {pinnedReminders.map((r) => {
                const overdue = Date.parse(r.dueAt) <= now
                const src = events.find((e) => e.reminder?.op === 'created' && e.reminder.id === r.id)
                return (
                  <div key={r.id} className={`jr-pinned-row ${overdue ? 'overdue' : ''}`}>
                    <button
                      type="button" className="jr-pinned-text"
                      title={C.openReminderGo} aria-label={C.openReminderGo}
                      disabled={!src}
                      onClick={() => { if (src) jumpToRow(src.id) }}
                    >
                      <span className="jr-pinned-due">
                        {overdue ? C.overdueLabel : C.dueAtLabel.replace('{t}', dueClock(r.dueAt))}
                      </span>
                      <span>{r.text}</span>
                    </button>
                    <button
                      type="button" className="jr-rem"
                      disabled={!onReminderDone}
                      title={C.markDoneTitle} aria-label={C.markDoneTitle}
                      onClick={() => onReminderDone?.(r)}
                    ><span className="jr-rem-box"><Icon id="check" /></span></button>
                  </div>
                )
              })}
            </div>
          )}
          {groupByDay(events).map((g, gi) => (
            <Fragment key={g.label ?? `today-${gi}`}>
              {g.label && <div className="jr-day-sep" role="separator">{g.label}</div>}
              {g.events.map((e) => {
            const target = targetOf(e)
            // ── during a Wiedergabe every row is a way into the picture ──
            // A row's tap sets the MOMENT, so the map, the Trupps and the Plan all read as they
            // did when the line was written. That is the question the old «anheften» toggle was
            // really being asked, and this answers it for EVERY row rather than for the few
            // somebody remembered to pin — including the ones written before the toggle existed.
            const rowMs = e.at ? Date.parse(e.at) : NaN
            const seekable = onSeekTo != null && Number.isFinite(rowMs)
            const clickable = seekable || target != null
            const onRow = seekable ? () => onSeekTo(e) : target != null ? () => onSelect(e) : undefined
            // …and rows the playhead has not reached yet are the future: shown (the Verlauf stays
            // whole and searchable) but visibly not-yet, so nothing on screen claims to be part of
            // the moment being looked at.
            const future = replayAtMs != null && Number.isFinite(rowMs) && rowMs > replayAtMs
            // a `created` reminder row: still-open (look up derived state) ⇒ show due + done
            // toggle; gone from the open set ⇒ already erledigt (checked + struck through).
            const isReminder = e.kind === 'reminder' && e.reminder?.op === 'created'
            const openRem = isReminder && e.reminder ? openMap.get(e.reminder.id) : undefined
            const remDone = isReminder && !openRem
            const remOverdue = !!openRem && Date.parse(openRem.dueAt) <= now
            return (
              <div
                className={`hist-ev ${clickable ? 'clickable' : ''} ${future ? 'jr-future' : ''}`}
                key={e.id}
                data-ev={e.id}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={onRow}
                onKeyDown={onRow ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onRow() } } : undefined}
              >
                <span className="t">{rowTime(e)}</span>
                <span className="ic"><Icon id={e.icon || 'doc'} /></span>
                <span className="tx">
                  <span className={`jr-chip jr-chip-${e.surface ?? 'map'}`}>{chip(e, plans)}</span>
                  {isNachtrag(e, closedAt) && <span className="jr-chip jr-chip-nachtrag">{C.nachtrag}</span>}
                  {/* the names in the sentence, marked — the same vocabulary and the same
                      marking the composer used while it was being typed */}
                  <span className={`jr-text ${remDone ? 'jr-rem-struck' : ''}`}>
                    {/* the job after the name, on its first mention — «Widmer Céline (EL)».
                        A Verlauf full of surnames tells a reader who was talking only if they
                        already know the Wehr; six months later, or on a Nachbarwehr's copy,
                        nobody does. Quiet weight: it is context for the name, not a second one. */}
                    {linkParts(e.text, vocab).map((p, pi) => (p.kind
                      ? (
                        <b key={pi} className={`jr-link jr-link-${p.kind}`}>
                          {p.text}
                          {p.role && <i className="jr-link-role"> ({p.role})</i>}
                        </b>
                      )
                      : <span key={pi}>{p.text}</span>))}
                  </span>
                </span>
                {isReminder && (
                  <button
                    className={`jr-rem ${remDone ? 'done' : remOverdue ? 'overdue' : ''}`}
                    disabled={remDone || !openRem || !onReminderDone}
                    title={remDone ? C.doneState : C.markDoneTitle}
                    aria-label={remDone ? C.doneState : C.markDoneTitle}
                    onClick={(ev) => { ev.stopPropagation(); if (openRem && onReminderDone) onReminderDone(openRem) }}
                  >
                    <span className="jr-rem-box"><Icon id="check" /></span>
                    <span className="jr-rem-due">
                      {remDone ? C.doneState : remOverdue ? C.overdueLabel : C.dueAtLabel.replace('{t}', dueClock(openRem!.dueAt))}
                    </span>
                  </button>
                )}
                {/* opens IN the app (lib/ui · openPhoto): `target="_blank"` handed the picture to
                    Safari on an installed iPad, which means leaving a running Einsatz to look at
                    a photo of it. The viewer keeps the one thing the new tab was good for — a
                    download. */}
                {rowPhotos(e).map((url, i) => (
                  <button
                    key={url} type="button" className="jr-thumb" title={C.photoOpen} aria-label={C.photoOpen}
                    onClick={(ev) => { ev.stopPropagation(); openPhoto(url, { caption: e.text, filename: `foto-${e.id}-${i + 1}.jpg` }) }}
                  >
                    <img src={url} alt="" />
                  </button>
                ))}
                {!e.audioUrl && e.at && (onOpenPlayer || onEditText) && (() => {
                  // annotation of a recording → jump into the player at this moment,
                  // and (editors) correct its text via an append-only patch
                  const t = Date.parse(e.at)
                  const w = audioWindows.find((x) => t >= x.start && t <= x.end)
                  if (!w) return null
                  return (
                    <>
                      {onEditText && (
                        <button
                          className="jr-jump"
                          title={C.editEntry}
                          aria-label={C.editEntry}
                          onClick={(ev) => { ev.stopPropagation(); setEditRow({ id: e.id, value: e.text }) }}
                        ><Icon id="pen" /></button>
                      )}
                      {onOpenPlayer && (
                        <button
                          className="jr-jump"
                          title={C.playerOpen}
                          aria-label={C.playerOpen}
                          onClick={(ev) => { ev.stopPropagation(); onOpenPlayer(w.row, (t - w.start) / 1000) }}
                        ><Icon id="wave" /></button>
                      )}
                    </>
                  )
                })()}
                {/* ── Durchhören + Transkript, IN der Zeile ──
                    These were two full-width labelled buttons on a line of their own below the
                    row. On a phone they never fitted side by side, so every voice memo was a
                    three-line block and the amber «Transkript ergänzen» shouted louder than the
                    entry it belonged to — two memos in a row and half the Verlauf was button.
                    As icons beside the play circle an audio row is one row again, like every
                    other row. The missing-transcript state keeps its amber, on the icon's frame
                    rather than as a filled block; the transcript TEXT still gets its own line
                    below (see .jr-transcript) — that is content, not a control. */}
                {e.audioUrl && e.audioMeta && onOpenPlayer && (
                  <button
                    className="jr-jump"
                    title={C.playerOpen}
                    aria-label={C.playerOpen}
                    onClick={(ev) => { ev.stopPropagation(); onOpenPlayer(e) }}
                  ><Icon id="wave" /></button>
                )}
                {e.audioUrl && onTranscript && (
                  <button
                    className={`jr-jump ${e.transcript ? '' : 'jr-jump-miss'}`}
                    title={e.transcript ? C.transcriptEdit : C.transcriptAdd}
                    aria-label={e.transcript ? C.transcriptEdit : C.transcriptAdd}
                    onClick={(ev) => { ev.stopPropagation(); setEditTx({ id: e.id, value: e.transcript ?? '' }) }}
                  ><Icon id={e.transcript ? 'type' : 'warn'} /></button>
                )}
                {e.audioUrl && (
                  <button
                    className={`tl-play ${audio.playing === e.id ? 'playing' : ''}`}
                    title={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                    aria-label={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                    onClick={(ev) => { ev.stopPropagation(); audio.toggle(e.id, e.audioUrl!) }}
                  ><Icon id={audio.playing === e.id ? 'pause' : 'play'} /></button>
                )}
                {(rowPhotos(e).length > 0 || e.audioUrl) && mediaStatusOf?.(e.id) && (
                  <span className={`jr-media-state ${mediaStatusOf(e.id) === 'failed' ? 'failed' : 'pending'}`}
                    title={mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}>
                    <Icon id={mediaStatusOf(e.id) === 'failed' ? 'warn' : 'rotate'} />
                    <span>{mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}</span>
                  </span>
                )}
                {clickable && <span className="hist-go" aria-hidden><Icon id={e.pinned ? 'coords' : 'chevron'} /></span>}
                {/* the transcript itself, on its own line under the row — either the text, or
                    the field to write it in. The two ways IN live in the row above. */}
                {e.audioUrl && (editTx?.id === e.id || e.transcript) && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    {editTx?.id === e.id ? (
                      <>
                        <textarea
                          value={editTx.value}
                          rows={3}
                          autoFocus
                          placeholder={C.transcriptPlaceholder}
                          onChange={(ev) => setEditTx({ id: e.id, value: ev.target.value })}
                          onKeyDown={(ev) => { if (ev.key === 'Escape') setEditTx(null) }}
                        />
                        <div className="jr-transcript-actions">
                          <button onClick={() => setEditTx(null)}>{appConfig.copy.cancel}</button>
                          <button onClick={saveTranscript}><Icon id="check" />{C.transcriptSave}</button>
                        </div>
                      </>
                    ) : <p>{e.transcript}</p>}
                  </div>
                )}
                {editRow?.id === e.id && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    <textarea
                      value={editRow.value}
                      rows={2}
                      autoFocus
                      onChange={(ev) => setEditRow({ id: e.id, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Escape') setEditRow(null) }}
                    />
                    <div className="jr-transcript-actions">
                      <button onClick={() => setEditRow(null)}>{appConfig.copy.cancel}</button>
                      <button onClick={saveRowText}><Icon id="check" />{C.transcriptSave}</button>
                    </div>
                  </div>
                )}
              </div>
            )
              })}
            </Fragment>
          ))}
        </div>
    </Overlay>
  )
}
