import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanDocument, TimelineEvent } from '../types'
import { Icon } from '../lib/icons'
import { EmptyState } from './EmptyState'
import { appConfig } from '../config/appConfig'
import { formatTime } from '../lib/format'
import { groupByDay, isNachtrag, rowTime } from '../lib/verlauf'
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
export function Journal({ events, plans, closedAt, onSelect, onClose, onTranscript, onReplay, openReminders, onReminderDone, mediaStatusOf, onOpenPlayer, onEditText }: {
  events: TimelineEvent[]
  plans: PlanDocument[]
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
  return (
    <>
      <div className="journal-scrim" onClick={onClose} />
      <aside className="journal-drawer" role="dialog" aria-label={C.title}>
        <div className="journal-head">
          <span className="journal-title"><Icon id="history" />{C.title} · {events.length}</span>
          {onReplay && (
            <button className="journal-replay" onClick={onReplay} title={C.replayHint}>
              <Icon id="play" /><span>{C.replay}</span>
            </button>
          )}
          <button className="journal-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
        </div>
        <div className="history-list">
          {events.length === 0 && <EmptyState icon="history" title={C.empty} />}
          {groupByDay(events).map((g, gi) => (
            <Fragment key={g.label ?? `today-${gi}`}>
              {g.label && <div className="jr-day-sep" role="separator">{g.label}</div>}
              {g.events.map((e) => {
            const target = targetOf(e)
            const clickable = target != null
            // a `created` reminder row: still-open (look up derived state) ⇒ show due + done
            // toggle; gone from the open set ⇒ already erledigt (checked + struck through).
            const isReminder = e.kind === 'reminder' && e.reminder?.op === 'created'
            const openRem = isReminder && e.reminder ? openMap.get(e.reminder.id) : undefined
            const remDone = isReminder && !openRem
            const remOverdue = !!openRem && Date.parse(openRem.dueAt) <= now
            return (
              <div
                className={`hist-ev ${clickable ? 'clickable' : ''}`}
                key={e.id}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onSelect(e) : undefined}
                onKeyDown={clickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(e) } } : undefined}
              >
                <span className="t">{rowTime(e)}</span>
                <span className="ic"><Icon id={e.icon || 'doc'} /></span>
                <span className="tx">
                  <span className={`jr-chip jr-chip-${e.surface ?? 'map'}`}>{chip(e, plans)}</span>
                  {isNachtrag(e, closedAt) && <span className="jr-chip jr-chip-nachtrag">{C.nachtrag}</span>}
                  <span className={`jr-text ${remDone ? 'jr-rem-struck' : ''}`}>{e.text}</span>
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
                      {remDone ? C.doneState : remOverdue ? C.overdueLabel : C.dueAtLabel.replace('{t}', formatTime(new Date(openRem!.dueAt)))}
                    </span>
                  </button>
                )}
                {e.photoUrl && (
                  <a className="jr-thumb" href={e.photoUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                    <img src={e.photoUrl} alt="" />
                  </a>
                )}
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
                {e.audioUrl && (
                  <button
                    className={`tl-play ${audio.playing === e.id ? 'playing' : ''}`}
                    title={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                    aria-label={audio.playing === e.id ? appConfig.copy.journal.recordStop : appConfig.copy.play}
                    onClick={(ev) => { ev.stopPropagation(); audio.toggle(e.id, e.audioUrl!) }}
                  ><Icon id={audio.playing === e.id ? 'pause' : 'play'} /></button>
                )}
                {(e.photoUrl || e.audioUrl) && mediaStatusOf?.(e.id) && (
                  <span className={`jr-media-state ${mediaStatusOf(e.id) === 'failed' ? 'failed' : 'pending'}`}
                    title={mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}>
                    <Icon id={mediaStatusOf(e.id) === 'failed' ? 'warn' : 'rotate'} />
                    <span>{mediaStatusOf(e.id) === 'failed' ? C.mediaFailed : C.mediaPending}</span>
                  </span>
                )}
                {clickable && <span className="hist-go" aria-hidden><Icon id={e.pinned ? 'coords' : 'chevron'} /></span>}
                {e.audioUrl && (onTranscript || (e.audioMeta && onOpenPlayer)) && (
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
                    ) : (
                      <>
                        {e.transcript && <p>{e.transcript}</p>}
                        <div className="jr-tx-actions">
                          {e.audioMeta && onOpenPlayer && (
                            <button className="jr-open" title={C.playerOpen} onClick={() => onOpenPlayer(e)}>
                              <Icon id="wave" />{C.playerOpen}
                            </button>
                          )}
                          {onTranscript && (
                            <button
                              className={e.transcript ? '' : 'jr-tx-missing'}
                              onClick={() => setEditTx({ id: e.id, value: e.transcript ?? '' })}
                            >
                              <Icon id={e.transcript ? 'type' : 'warn'} />{e.transcript ? C.transcriptEdit : C.transcriptAdd}
                            </button>
                          )}
                        </div>
                      </>
                    )}
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
      </aside>
    </>
  )
}
