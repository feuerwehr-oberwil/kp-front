// Formatting and photo-URL helpers for the Objektbesuche surface (no components here, so the
// component modules stay fast-refresh clean).

import { useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, fmtWhen, formatTime, unitLabel, formatLocale } from '../../lib/format'
import { attachmentUrl } from '../../objectVisits/api'
import { readAttachment } from '../../objectVisits/store'
import type { DeliveryState, SyncState } from '../../objectVisits/status'
import type { Answer, Lifecycle, VisitConflict, VisitDoc, VisitSummary } from '../../objectVisits/types'
import type { Item } from '../../lib/checklists'
import { checklistItems } from '../../objectVisits/doc'
import { placeOf } from '../../objectVisits/place'

/** dd.mm.yyyy in the station's locale */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleDateString(formatLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch {
    return d.toLocaleDateString()
  }
}

/** dd.mm. — for a chip */
export function fmtDayShort(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
}

export function fmtDistance(m: number): string {
  const C = appConfig.copy.objectVisits
  return m < 1000 ? fillTemplate(C.distanceM, { m: Math.round(m / 10) * 10 }) : fillTemplate(C.distanceKm, { km: (m / 1000).toFixed(1) })
}

/** «1 X» / «{n} X» from a one/many pair */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : fillTemplate(many, { n })
}

/**
 * The picture for a photo: the device's own thumbnail (or full blob) when it has one — offline
 * included — else the server's. A photo whose full bytes were released after the server
 * acknowledged them (outbox · releaseSettled) shows the server's full picture when it
 * can be fetched and falls back to the thumbnail on this device (`fallback`, for the img's
 * onError). Object URLs are revoked when the tile goes.
 */
export function usePhotoUrl(visitId: string, attId: string, { full = false, remote = true } = {}): { url: string | null; fallback: string | null; local: boolean } {
  const [state, setState] = useState<{ url: string | null; fallback: string | null; local: boolean }>({ url: null, fallback: null, local: false })
  useEffect(() => {
    let alive = true
    const made: string[] = []
    const mk = (b: Blob) => { const u = URL.createObjectURL(b); made.push(u); return u }
    void readAttachment(attId).then((r) => {
      if (!alive) return
      const a = r.ok ? r.value : null
      if (full && a?.blob) setState({ url: mk(a.blob), fallback: null, local: true })
      else if (full && a?.thumb) setState({ url: remote ? attachmentUrl(visitId, attId) : mk(a.thumb), fallback: remote ? mk(a.thumb) : null, local: !remote })
      else if (!full && (a?.thumb ?? a?.blob)) setState({ url: mk((a.thumb ?? a.blob)!), fallback: null, local: true })
      else if (remote) setState({ url: attachmentUrl(visitId, attId, !full), fallback: null, local: false })
    })
    return () => {
      alive = false
      for (const u of made) URL.revokeObjectURL(u)
    }
  }, [visitId, attId, full, remote])
  return state
}


/** The device → server segment's words. */
export function syncLabel(sync: SyncState): string {
  const S = appConfig.copy.objectVisits.sync
  switch (sync.kind) {
    case 'unsaved': return S.unsaved
    case 'conflict': return S.conflict
    case 'auth': return S.auth
    case 'error': return S.error
    case 'sending': return S.sending
    case 'local': return sync.at ? fillTemplate(S.localAt, { time: fmtWhen(sync.at, { todayShort: true }) }) : S.local
    case 'changes': return fillTemplate(S.changes, { time: fmtWhen(sync.at, { todayShort: true }) })
    case 'photos': return fillTemplate(S.photos, { done: sync.photosDone ?? 0, total: sync.photosTotal ?? 0 })
    case 'saved': return fillTemplate(S.saved, { time: fmtWhen(sync.at, { todayShort: true }) })
    case 'remote': return fillTemplate(S.remote, { n: sync.revision ?? 0 })
  }
}

/** The HEAD's short form of the same state (owner, 03.10.2026: the long words did not fit a
 *  phone's head). Where the glyph already says what happened — ✓ saved, 🕑 on this device — only
 *  the time is left; everything else keeps its (short) word. The sheet keeps the long ones. */
export function syncShort(sync: SyncState): string {
  switch (sync.kind) {
    case 'saved':
    case 'changes': return fmtWhen(sync.at, { todayShort: true })
    case 'local': return sync.at ? fmtWhen(sync.at, { todayShort: true }) : appConfig.copy.objectVisits.sync.local
    default: return syncLabel(sync)
  }
}

/** The filing segment's words, or null when no destination is configured (hidden). */
export function deliveryLabel(d: DeliveryState): string | null {
  const D = appConfig.copy.objectVisits.delivery
  return d.kind === 'none' ? null : D[d.kind]
}

export function lifecycleLabel(l: Lifecycle): string {
  return appConfig.copy.objectVisits.lifecycle[l]
}

/** An answer as words — the read view, the conflict card, the export. */
export function answerText(item: Item | undefined, a: Answer | null | undefined): string {
  const C = appConfig.copy.objectVisits
  if (!a || a.v === '' || a.v == null) return C.notChecked
  const input = item?.input ?? 'check'
  if (input === 'choice') return item?.options?.find((o) => o.id === a.v)?.label ?? String(a.v)
  if (input === 'number') return `${a.v}${item?.unit ? ` ${unitLabel(item.unit)}` : ''}`
  const words = C.answer as Record<string, string>
  if (typeof a.v === 'string' && words[a.v] && input !== 'text') return words[a.v]
  return String(a.v)
}

/** What a conflict card is about («Bemerkungen», the item's question, «Foto» …). */
export function conflictWhat(c: VisitConflict, doc: VisitDoc): string {
  const W = appConfig.copy.objectVisits.conflictWhat
  if (c.key.startsWith('answers.')) {
    const id = c.key.slice('answers.'.length)
    return checklistItems(doc.checklist).find((i) => i.id === id)?.text ?? id
  }
  if (c.key.startsWith('photos.')) return W.photo
  if (c.key.startsWith('proposals.')) return W.proposal
  return (W as Record<string, string>)[c.key] ?? c.key
}

/** One side of a conflict as text. */
export function conflictValue(c: VisitConflict, side: unknown, doc: VisitDoc): string {
  const C = appConfig.copy.objectVisits
  if (side == null) return C.conflictRemoved
  if (c.key.startsWith('answers.')) {
    const id = c.key.slice('answers.'.length)
    return answerText(checklistItems(doc.checklist).find((i) => i.id === id), side as Answer)
  }
  if (typeof side === 'string') return c.key === 'visitedAt' ? `${fmtDate(side)} ${formatTime(new Date(side))}` : side
  if (Array.isArray(side)) return side.join(', ')
  const o = side as Record<string, unknown>
  if (typeof o.caption === 'string') return o.caption || C.photoTitle
  if (typeof o.proposed === 'string') return `${o.label ?? ''}: ${o.proposed}`
  if (typeof o.title === 'string') return o.title
  if (typeof o.name === 'string') return o.name
  if (typeof o.label === 'string') return o.label // a place (`target`)
  return JSON.stringify(side)
}

/** A row of the server's list, named like its visit (an older server: the object's name). */
export function summaryTitle(v: Pick<VisitSummary, 'objectName' | 'target_kind' | 'location'>): string {
  if (v.target_kind === 'location') return fillTemplate(appConfig.copy.objectVisits.placeTitle, { label: v.location?.label ?? '' })
  return v.objectName ?? v.location?.label ?? ''
}

export interface PlaceVisitRow { id: string; label: string; visitedAt: string; checklist: string | null; people: string }

/** The finished visits at a place this device knows of — its own copies over the server's rows —
 *  newest first, at most `limit`. Drafts are under «Meine Entwürfe» already. */
export function recentPlaceVisits(
  locals: { doc: VisitDoc }[],
  summaries: VisitSummary[] | null,
  limit = 8,
): PlaceVisitRow[] {
  const rows = new Map<string, PlaceVisitRow>()
  for (const v of summaries ?? []) {
    if (v.target_kind !== 'location' || v.lifecycle !== 'completed') continue
    rows.set(v.id, {
      id: v.id, label: v.location?.label ?? '', visitedAt: v.visitedAt,
      checklist: v.checklist?.title ?? null, people: (v.with ?? []).join(', '),
    })
  }
  for (const l of locals) {
    const place = placeOf(l.doc)
    if (!place) continue
    if (l.doc.lifecycle !== 'completed') { rows.delete(l.doc.id); continue }
    rows.set(l.doc.id, {
      id: l.doc.id, label: place.label, visitedAt: l.doc.visitedAt,
      checklist: l.doc.checklist?.title ?? null, people: (l.doc.with ?? []).join(', '),
    })
  }
  return [...rows.values()].sort((a, b) => (a.visitedAt < b.visitedAt ? 1 : -1)).slice(0, limit)
}

/** What the visit is called on every screen: its object's name, or — a visit at a place —
 *  «Meldung bei Talholzstrasse 15». */
export function visitTitle(doc: Pick<VisitDoc, 'object' | 'target'>): string {
  const place = placeOf(doc)
  if (!place) return doc.object?.name ?? ''
  return fillTemplate(appConfig.copy.objectVisits.placeTitle, { label: place.label })
}

/**
 * The visit card's result line for a checklist that asks no OK/Mangel question — a Fehlermeldung
 * is a report, and «Keine Mängel» under it would say the opposite of what it is. Its answered
 * choices and texts, in order, «Hydrant · Neuer Hydrant fehlt im Plan» (null when there are none).
 */
export function answerDigest(doc: Pick<VisitDoc, 'checklist' | 'answers'>, max = 160): string | null {
  const items = checklistItems(doc.checklist)
  if (items.some((i) => (i.input ?? 'check') === 'check')) return null
  const parts = items
    .filter((i) => i.input === 'choice' || i.input === 'text')
    .map((i) => {
      const a = doc.answers[i.id]
      return a && a.v !== '' && a.v != null ? answerText(i, a).replace(/\s+/g, ' ').trim() : ''
    })
    .filter(Boolean)
  if (!parts.length) return null
  const line = parts.join(' · ')
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
