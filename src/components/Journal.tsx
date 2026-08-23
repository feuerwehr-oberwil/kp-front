import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanDocument, TimelineEvent } from '../types'
import { linkParts, type JournalLink } from '../lib/journalLinks'
import { Icon } from '../lib/icons'
import { EmptyState } from './EmptyState'
import { Overlay } from '../lib/overlays'
import { caretToEnd, openPhoto } from '../lib/ui'
import { appConfig } from '../config/appConfig'
import { dueClock, fillTemplate, formatTime } from '../lib/format'
import { groupByDay, isHandWritten, isNachtrag, repeatRuns, rowPhotos, rowTime } from '../lib/verlauf'
import { journalArea } from '../lib/report'
import { formatElapsed } from '../lib/audioPlayer'
import type { OpenReminder } from '../lib/reminders'

/** HH:MM of an ISO instant — the Pendenzen block's time column and its Meldung lines. */
function rowClock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '–' : formatTime(d)
}

/** «vor 54 min» / «vor 3 h» — the other half of the time column, one tap away. */
function ageLabel(iso: string, nowMs: number, C: typeof appConfig.copy.journal): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '–'
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000))
  return mins < 90 ? C.ageLabel.replace('{n}', String(mins)) : C.ageLabelHours.replace('{n}', String(Math.round(mins / 60)))
}

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

// Short chip: WHERE in the app the entry came from — the same classification the printed
// rapport's «Bereich» column uses (lib/report · journalArea), so screen and paper agree.
// It used to read the `surface` alone, which the generic logger stamps as 'map' on
// everything — Anwesenheit, Mittel, Atemschutz all said «Lage». One exception: the print
// calls the map surface «Kroki» (the word people search the export for); on screen the
// tab is called Lage, so the chip keeps that name.
const chip = (e: TimelineEvent, plans: PlanDocument[]): string => {
  const C = appConfig.copy.journal // read at call time so the resolved locale applies
  const area = journalArea(e, plans)
  if (area === appConfig.copy.report.areaLage) return C.surfaceMap
  // a type name breaks on its SET Trennstellen (entryTypesWrap), like the composer's chips —
  // «Sofortmassnahme» unhyphenated blows the chip open on a phone
  const typed = Object.entries(C.entryTypes).find(([, label]) => label === area)
  return typed ? (C.entryTypesWrap[typed[0]] ?? area) : area
}

// The unified Verlauf — the single, append-only stream of everything that
// happens on either surface. Rendered as a slide-over so it can open over the
// map or the plan; a row jumps back to wherever its event happened.
export function Journal({ events, plans, closedAt, vocab = [], onSelect, onClose, onTranscript, onReplay, openReminders, onReminderDone, onReminderNote, mediaStatusOf, onOpenPlayer, onEditText, replayAtMs, onSeekTo, landOn }: {
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
  /** write a Meldung on an open item — opens the ordinary composer pre-linked to it. */
  onReminderNote?: (r: OpenReminder) => void
  /** offline-queue status of a row's media (photo/audio not yet on the server), or undefined
   *  once uploaded — drives the "wird geladen"/"nicht geladen" chip on media rows. */
  mediaStatusOf?: (rowId: string) => 'pending' | 'failed' | undefined
  /** open the Durchhören player sheet for a long recording (rows with audioMeta);
   *  seekSec jumps straight to a moment inside it (annotation rows link back) */
  onOpenPlayer?: (e: TimelineEvent, seekSec?: number) => void
  /** correct a HAND-WRITTEN row's text — append-only `textEdit` patch, same pattern as the
   *  transcript edit. Offered on everything a person typed (composer entries, Meldungen,
   *  Nachdokumentation in the player) and on nothing the app wrote about an action; the
   *  corrected line is marked «korrigiert HH:MM». See lib/verlauf · isHandWritten. */
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
  // id → the item's own words, so a Meldung row can name what it is an answer to. Built from the
  // `created` rows themselves (not from `openReminders`), or a Meldung on an item that has since
  // been ticked off would lose its anchor the moment it was closed.
  const pendenzTitles = useMemo(() => new Map(
    events.filter((e) => e.reminder?.op === 'created')
      .map((e) => [e.reminder!.id, (e.reminder!.text ?? e.text).trim()] as const),
  ), [events])
  /** …and the row each one was raised on, so the reference on a Meldung can jump back to it. */
  const pendenzRowIds = useMemo(() => new Map(
    events.filter((e) => e.reminder?.op === 'created').map((e) => [e.reminder!.id, e.id] as const),
  ), [events])
  const [now] = useState(() => Date.now())
  // the Pendenzen block: how many rows it may take, and whether the time column shows the clock
  // or the age. The toggle is per-opening (the drawer remounts each time) — it is a reading
  // preference for the minute you are in, not a setting worth persisting.
  // ⚠️ EVERY open item is rendered — the block scrolls instead of hiding rows behind a count.
  // A cap of four meant «12 offen» in the heading over a list showing three, and the way to the
  // rest was a control that had to be found. What the toggle changes now is only the block's
  // HEIGHT: half the drawer, or all of it.
  const [expanded, setExpanded] = useState(false)
  // …and the toggle appears only when the collapsed block cannot show everything. Measured, not
  // counted: one item carrying four Meldungen is taller than four bare ones, so a row count
  // cannot answer «does this fit».
  const pinnedRef = useRef<HTMLDivElement | null>(null)
  const [pinnedOverflows, setPinnedOverflows] = useState(false)
  const [showAge, setShowAge] = useState(false)
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

  // A state the app re-states («Trupp X überfällig» every few seconds, an undo tapped six times)
  // reads as one line that repeated, not as twenty lines. Display only — see lib/verlauf.
  const repeats = useMemo(() => repeatRuns(events), [events])

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
  // one marking for every piece of prose in the drawer — the row text and the transcript
  // subtitle lines mark the same vocabulary the composer marked while it was being typed
  const marked = (text: string) => linkParts(text, vocab).map((p, pi) => (p.kind
    ? (
      <b key={pi} className={`jr-link jr-link-${p.kind}`}>
        {p.text}
        {p.role && <i className="jr-link-role"> ({p.role})</i>}
      </b>
    )
    : <span key={pi}>{p.text}</span>))

  const jumpToRow = (id: string, smooth = false) => {
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
    // ⚠️ `smooth` only where a PERSON asked to go somewhere (the reference on a Meldung): the
    // travel is what shows that the target row is a different row, further up, rather than the
    // list having silently redrawn. The landing loop below must stay instant — it re-corrects for
    // a few hundred ms as fonts and media settle, and an animation would be fighting the next
    // correction on every frame.
    if (smooth) list.scrollBy({ top: delta, behavior: 'smooth' })
    else {
      list.scrollTop += delta
      // it should have moved. If it did not, this list is not the box that scrolls.
      // (Not checked for a smooth scroll — nothing has moved yet by the time this line runs.)
      if (Math.abs(delta) > 2 && list.scrollTop === before) el.scrollIntoView({ block: 'center' })
    }
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

  // ⚠️ NOT re-sorted here. lib/reminders already orders them — dringend first, then oldest first
  // — and it is the same order the Rapport prints. Two sorts in two places is how the list on
  // screen and the list on paper start disagreeing about what is most urgent.
  const pinnedReminders = openReminders ?? []

  /**
   * Does the collapsed block hold more than it can show? The answer decides whether «Aufklappen»
   * exists at all, so getting it wrong makes a capped list one with no way out.
   *
   * ⚠️ A REF CALLBACK, not an effect reading `pinnedRef.current`. That was tried twice and never
   * ran once: this drawer is an `<Overlay>`, and the overlay mounts its children in a LATER commit
   * than the component's own layout effect — so `pinnedRef.current` was null, the effect took its
   * `if (!el)` exit, and because `openReminders` does not change identity afterwards it was never
   * asked again. React calls a ref callback exactly when the node attaches, whatever the commit
   * order, which is the one hook that cannot be early.
   *
   * Then it keeps watching, because «fits» has several answers over time: the next frame (fonts
   * swap and a wrapped item is a different height), any resize of the block or its rows, and the
   * scroll event — anything that scrolls has overflowed, by definition.
   */
  const detachPinned = useRef<(() => void) | null>(null)
  const attachPinned = useCallback((el: HTMLDivElement | null) => {
    detachPinned.current?.()
    detachPinned.current = null
    pinnedRef.current = el
    if (!el) { setPinnedOverflows(false); return }
    const measure = () => setPinnedOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    el.addEventListener('scroll', measure, { passive: true })
    detachPinned.current = () => { cancelAnimationFrame(raf); ro.disconnect(); el.removeEventListener('scroll', measure) }
  }, [])
  // …and once more when the open set or the expansion changes: rows come and go without the block
  // itself resizing (it is capped), so the ResizeObserver alone would not notice.
  useEffect(() => {
    const el = pinnedRef.current
    if (el) setPinnedOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [openReminders, expanded])

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
        {/* ⚠️ `jr-locked`: expanded AND at its cap, the Pendenzen block covers the whole list, so
            scrolling the Verlauf underneath moves something nobody can see — and a gesture that
            starts on the block but chains out of it is exactly how you lose your place in a list
            you are working through. The lock is on both conditions: expanded but SHORT (a handful
            of items) leaves the Verlauf visible below, and then it must still scroll. */}
        <div className={`history-list${expanded && pinnedOverflows ? ' jr-locked' : ''}`} ref={listRef}>
          {events.length === 0 && <EmptyState icon="history" title={C.empty} />}
          {/* OFFENE ERINNERUNGEN, held at the top. The only rows in this list that are not where
              they happened — deliberately: a Wiedervorlage is about what still has to be done,
              and on an Einsatz that writes a row a minute it was scrolled past within ten. Each
              one jumps to its own place in the chronology, which is where the record keeps it. */}
          {pinnedReminders.length > 0 && (
            <div ref={attachPinned} className={`jr-pinned${expanded ? ' is-open' : ''}`}>
              <div className="jr-pinned-head">
                <Icon id="checklist" /><span>{C.openRemindersHead}</span>
                <b>{C.openCount.replace('{n}', String(pinnedReminders.length))}</b>
              </div>
              {pinnedReminders.map((r) => {
                // ⚠️ The time column says WHEN IT WAS RAISED, for every row, always. It used to
                // say «fällig 22:10 / überfällig», which only a timed Erinnerung can answer — an
                // Auftrag has no Fälligkeit, because nobody checks in on a Schadenplatz. What is
                // actually being asked here is «seit wann läuft das», and the sort order (oldest
                // first) already answers it positionally; tapping swaps the column to the age for
                // the times the clock stops answering it. Überfällig stays the banner's business.
                const dueLater = r.dueAt && Date.parse(r.dueAt) > now
                return (
                  <div key={r.id} className={`jr-pinned-row ${r.urgent ? 'urgent' : ''}`}>
                    <button
                      type="button" className="jr-when"
                      title={C.ageToggle} aria-label={C.ageToggle}
                      onClick={() => setShowAge((v) => !v)}
                    >{showAge ? ageLabel(r.createdAt, now, C) : rowClock(r.createdAt)}</button>
                    {/* ⚠️ The ring sits in the VERLAUF'S ICON SLOT, before the text, not out at the
                        right margin. Two things come of it: the item's text starts on exactly the
                        same axis as every line in the log below, so the block reads as the same
                        list filtered rather than as a separate component — and the ring IS this
                        row's icon, which is what a checklist circle has always been. */}
                    <button
                      type="button" className="jr-rem"
                      disabled={!onReminderDone}
                      title={C.markDoneTitle} aria-label={C.markDoneTitle}
                      onClick={() => onReminderDone?.(r)}
                    ><span className="jr-rem-box"><Icon id="check" /></span></button>
                    {/* ⚠️ The Meldungen are SIBLINGS of the button, not children of it. Inside it
                        they rendered outside its box: a <button> is a replaced-ish element whose
                        height does not follow block children the way a div's does, so a row with
                        three Meldungen kept the height of one and the next row was drawn straight
                        over them. The button stays a button — one line, one action — and the
                        thread hangs under it in an ordinary div. */}
                    <div className="jr-pinned-body">
                      <button
                        type="button" className="jr-pinned-text"
                        title={C.noteOpen} aria-label={C.noteOpen}
                        disabled={!onReminderNote}
                        onClick={() => onReminderNote?.(r)}
                      >{r.text}</button>
                      {/* ⚠️ EVERY Meldung, not the latest one. They stand scattered through the
                          Verlauf where they happened, so this is the only place the thread reads
                          as a thread — and showing one of three looked like the whole story. */}
                      {r.notes.map((n) => (
                        <span className="jr-pinned-note" key={n.rowId}>
                          <b>{rowClock(n.at)}</b>{n.text}
                        </span>
                      ))}
                    </div>
                    {/* ⚠️ …and it says WHEN, not just that there is a when. The bare clock glyph
                        answered «meldet sich selbst» and left the one thing to act on — «um wie
                        viel Uhr?» — inside a tooltip nobody on a tablet can open. The row's own
                        time column says when the item was RAISED, so the two are never the same
                        number. `dueClock` adds «· morgen» where the Fälligkeit fell to the next
                        day, which is exactly the case a bare «06:30» reads as long overdue. */}
                    {dueLater && (
                      <span className="jr-pinned-alarm" title={C.dueAtLabel.replace('{t}', dueClock(r.dueAt!))}>
                        <Icon id="clock" /><b>{dueClock(r.dueAt!)}</b>
                      </span>
                    )}
                  </div>
                )
              })}
              {/* ⚠️ CAPPED. The block is sticky so it cannot be scrolled past — right for the two
                  Erinnerungen it used to hold, ruinous for the ten Pendenzen a Lagerapport
                  produces, which would leave no Verlauf at all. The sort decides what survives
                  the cap, so dringend and oldest are always among them. */}
              {/* ⚠️ Sticky at the FOOT of the block. Expanded it fills the drawer and scrolls, so a
                  «Zuklappen» sitting after the last row is one nobody can reach without scrolling
                  to the end of the very list they want to collapse. */}
              {(expanded || pinnedOverflows) && (
                <button type="button" className="jr-pinned-more" onClick={() => setExpanded((v) => !v)}>
                  <Icon id={expanded ? 'chevron-up' : 'chevron-down'} />
                  {expanded ? C.collapse : C.expand}
                </button>
              )}
            </div>
          )}
          {groupByDay(events).map((g, gi) => (
            <Fragment key={g.label ?? `today-${gi}`}>
              {g.label && <div className="jr-day-sep" role="separator">{g.label}</div>}
              {g.events.filter((e) => !repeats.hidden.has(e.id)).map((e) => {
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
            // ⚠️ Keyed off the LIFECYCLE EVENT, not off `kind === 'reminder'`. A Pendenz rides on
            // an ordinary entry row (kind 'journal' / 'audio' / 'photo'), because the entry IS the
            // open item — «Auftrag · Trupp 2 entraucht Treppenhaus» is the record and the Pendenz
            // in one line. Only the timed Erinnerung still writes a row of its own.
            const isReminder = e.reminder?.op === 'created'
            const openRem = isReminder && e.reminder ? openMap.get(e.reminder.id) : undefined
            const remDone = isReminder && !openRem
            const remOverdue = !!openRem?.dueAt && Date.parse(openRem.dueAt) <= now
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
                  {/* ⚠️ Neutral on purpose. The class used to be `jr-chip-${e.surface}` — blue for map,
                      green for plan — while the WORD comes from `journalArea`, which classifies by
                      entry type and icon. So an Atemschutz row drawn on the map surface rendered a
                      Lage-blue chip reading «ATEMSCHUTZ»: the colour claimed one Bereich and the
                      text said another. The word is the truthful carrier, so the tint is gone
                      rather than re-derived — one meaning per colour. */}
                  <span className="jr-chip jr-chip-area">{chip(e, plans)}</span>
                  {isNachtrag(e, closedAt) && <span className="jr-chip jr-chip-nachtrag">{C.nachtrag}</span>}
                  {/* a corrected line says so, with the time of the correction — see the pen below */}
                  {/* «und dann noch 5 Mal dasselbe» — the repeats are in the record, the row
                      says how often rather than being printed again (lib/verlauf · repeatRuns) */}
                  {(repeats.counts.get(e.id) ?? 1) > 1 && (
                    <span className="jr-chip jr-chip-rep" title={C.repeatedTitle}>
                      {fillTemplate(C.repeated, { n: String(repeats.counts.get(e.id)) })}
                    </span>
                  )}
                  {e.correctedAt && (
                    <span className="jr-chip jr-chip-korr" title={C.correctHint}>
                      {fillTemplate(C.corrected, { t: formatTime(new Date(e.correctedAt)) })}
                    </span>
                  )}
                  {/* The row that RAISED an item carries the chip — that is what marks it in the
                      record as something that had to come back. */}
                  {isReminder && (
                    <span className={`jr-chip jr-chip-pendenz${remDone ? ' done' : ''}`}>{C.noteChip}</span>
                  )}
                  {/* ⚠️ A MELDUNG names the ITEM instead. The word «PENDENZ» on all of them said
                      only what one could already see; what was missing is WHICH one, and three
                      «PENDENZ» rows in a row were three unrelated sentences. The Verlauf is
                      chronological, so each link has to carry its own anchor — and the anchor is
                      the item's own opening words, not a label. */}
                  {/* …and it is a WAY BACK, not a caption. The reference has to be truncated to
                      fit, so the words alone often cannot identify the item — tapping it scrolls
                      to the row that raised it and flashes it, which answers «which one» in full
                      and in its own context. */}
                  {e.reminder?.op === 'note' && pendenzTitles.get(e.reminder.id) && (
                    <button
                      type="button" className="jr-note-on"
                      title={C.openReminderGo} aria-label={C.openReminderGo}
                      onClick={(ev) => { ev.stopPropagation(); jumpToRow(pendenzRowIds.get(e.reminder!.id)!, true) }}
                      disabled={!pendenzRowIds.has(e.reminder.id)}
                    ><i>{pendenzTitles.get(e.reminder.id)}</i></button>
                  )}
                  {/* the names in the sentence, marked — the same vocabulary and the same
                      marking the composer used while it was being typed */}
                  <span className={`jr-text ${remDone ? 'jr-rem-struck' : ''}`}>
                    {/* the job after the name, on its first mention — «Widmer Céline (EL)».
                        A Verlauf full of surnames tells a reader who was talking only if they
                        already know the Wehr; six months later, or on a Nachbarwehr's copy,
                        nobody does. Quiet weight: it is context for the name, not a second one. */}
                    {marked(e.text)}
                  </span>
                </span>
                {/* ⚠️ NO tick-off control here any more. There were two: one on the row where the
                    item was raised and one in the pinned block above, doing the same thing to the
                    same item — and the row's was the worse of the two, because it scrolls away
                    while the block cannot. This row is the RECORD; the block is where you work.
                    A timed Erinnerung shows its Fälligkeit, since that is a fact about the entry
                    rather than a control. */}
                {isReminder && openRem?.dueAt && (
                  <span className={`jr-remstate ${remOverdue ? 'overdue' : ''}`}>
                    {remOverdue ? C.overdueLabel : C.dueAtLabel.replace('{t}', dueClock(openRem.dueAt))}
                  </span>
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
                {/* ── Der Stift ──
                    On everything a HUMAN typed, and on nothing else (lib/verlauf · isHandWritten).
                    A wrong Strassenname or a Trupp number off by one used to be uncorrectable:
                    the log is append-only, so the only ways out were a second line saying «oben
                    falsch» or leaving the error standing on the Rapport. The correction is itself
                    an appended row (a `textEdit` patch) — the original wording and the corrected
                    one both stay in the record and in the hash chain, and the line says «korrigiert
                    HH:MM» so nobody reads the new words as the ones spoken at the time.
                    ⚠️ NEVER on system rows. «Trupp 2 eingerückt» is the app reporting an action;
                    rewriting that sentence would make the record state something that did not
                    happen, which is the one thing this journal exists to prevent.
                    ⚠️ NOT on audio rows either. Their words live in the transcript, and the
                    transcript icon beside the play circle is the one way to write them — a
                    second editor for the row's own «Audionotiz (4s)» label stacked under the
                    transcript field and read as two competing text boxes for the same entry. */}
                {onEditText && isHandWritten(e) && !e.audioUrl && editRow?.id !== e.id && (
                  <button
                    className="jr-jump"
                    title={C.editEntry}
                    aria-label={C.editEntry}
                    onClick={(ev) => { ev.stopPropagation(); setEditRow({ id: e.id, value: e.text }) }}
                  ><Icon id="pen" /></button>
                )}
                {!e.audioUrl && e.at && onOpenPlayer && (() => {
                  // annotation of a recording → jump into the player at this moment
                  const t = Date.parse(e.at)
                  const w = audioWindows.find((x) => t >= x.start && t <= x.end)
                  if (!w) return null
                  return (
                    <button
                      className="jr-jump"
                      title={C.playerOpen}
                      aria-label={C.playerOpen}
                      onClick={(ev) => { ev.stopPropagation(); onOpenPlayer(w.row, (t - w.start) / 1000) }}
                    ><Icon id="wave" /></button>
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
                {e.audioUrl && onTranscript && (() => {
                  // sections written in the player count as transcription too — the amber asks
                  // for words that are missing, not for a particular field to be filled
                  const hasTx = !!e.transcript || !!e.transcriptSections?.length
                  return (
                    <button
                      className={`jr-jump ${hasTx ? '' : 'jr-jump-miss'}`}
                      title={hasTx ? C.transcriptEdit : C.transcriptAdd}
                      aria-label={hasTx ? C.transcriptEdit : C.transcriptAdd}
                      onClick={(ev) => { ev.stopPropagation(); setEditTx({ id: e.id, value: e.transcript ?? '' }) }}
                    ><Icon id={hasTx ? 'type' : 'warn'} /></button>
                  )
                })()}
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
                {/* the words, as SUBTITLE lines under the row — the plain transcript first (the
                    memo's words as one text, no offset), then the player's timed sections with
                    their offset into the recording. The row's own text stays «Audionotiz (8s)»:
                    that is what the entry IS; these lines are what it says. */}
                {e.audioUrl && editTx?.id !== e.id && (e.transcript || e.transcriptSections?.length) && (
                  <div className="jr-subs">
                    {e.transcript && <p><span>{marked(e.transcript)}</span></p>}
                    {(e.transcriptSections ?? []).map((s, i) => (
                      <p key={i}><i>{formatElapsed(s.at)}</i><span>{marked(s.text)}</span></p>
                    ))}
                  </div>
                )}
                {/* the transcript editor, on its own line under the row */}
                {e.audioUrl && editTx?.id === e.id && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    <textarea
                      value={editTx.value}
                      rows={3}
                      autoFocus
                      onFocus={caretToEnd}
                      placeholder={C.transcriptPlaceholder}
                      onChange={(ev) => setEditTx({ id: e.id, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Escape') setEditTx(null) }}
                    />
                    <div className="jr-transcript-actions">
                      {/* re-editing an existing transcript is a correction like any other —
                          appended, never overwritten — and says so; a first transcript has no
                          original wording to reassure about */}
                      {e.transcript && <span className="jr-korr-hint">{C.correctHint}</span>}
                      <button onClick={() => setEditTx(null)}>{appConfig.copy.cancel}</button>
                      <button onClick={saveTranscript}><Icon id="check" />{C.transcriptSave}</button>
                    </div>
                  </div>
                )}
                {editRow?.id === e.id && (
                  <div className="jr-transcript" onClick={(ev) => ev.stopPropagation()}>
                    <textarea
                      value={editRow.value}
                      rows={2}
                      autoFocus
                      onFocus={caretToEnd}
                      onChange={(ev) => setEditRow({ id: e.id, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Escape') setEditRow(null) }}
                    />
                    <div className="jr-transcript-actions">
                      <span className="jr-korr-hint">{C.correctHint}</span>
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
