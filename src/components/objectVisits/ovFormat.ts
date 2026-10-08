// Formatting and photo-URL helpers for the Objektbesuche surface (no components here, so the
// component modules stay fast-refresh clean).

import { useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { getLocaleId } from '../../config/copy'
import { fillTemplate, hhmm, unitLabel } from '../../lib/format'
import { attachmentUrl } from '../../objectVisits/api'
import { readAttachment } from '../../objectVisits/store'
import type { DeliveryState, SyncState } from '../../objectVisits/status'
import type { Answer, Lifecycle, VisitConflict, VisitDoc } from '../../objectVisits/types'
import type { Item } from '../../lib/checklists'
import { checklistItems } from '../../objectVisits/doc'

/** dd.mm.yyyy in the station's locale */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleDateString(getLocaleId(), { day: '2-digit', month: '2-digit', year: 'numeric' })
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

/** hh:mm today, «dd.mm. hh:mm» on another day */
export function fmtWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toDateString() === now.toDateString() ? hhmm(d) : `${fmtDayShort(iso)} ${hhmm(d)}`
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
    case 'local': return sync.at ? fillTemplate(S.localAt, { time: fmtWhen(sync.at) }) : S.local
    case 'changes': return fillTemplate(S.changes, { time: fmtWhen(sync.at) })
    case 'photos': return fillTemplate(S.photos, { done: sync.photosDone ?? 0, total: sync.photosTotal ?? 0 })
    case 'saved': return fillTemplate(S.saved, { time: fmtWhen(sync.at) })
    case 'remote': return fillTemplate(S.remote, { n: sync.revision ?? 0 })
  }
}

/** The HEAD's short form of the same state (owner, 03.10.2026: the long words did not fit a
 *  phone's head). Where the glyph already says what happened — ✓ saved, 🕑 on this device — only
 *  the time is left; everything else keeps its (short) word. The sheet keeps the long ones. */
export function syncShort(sync: SyncState): string {
  switch (sync.kind) {
    case 'saved':
    case 'changes': return fmtWhen(sync.at)
    case 'local': return sync.at ? fmtWhen(sync.at) : appConfig.copy.objectVisits.sync.local
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
  if (typeof side === 'string') return c.key === 'visitedAt' ? `${fmtDate(side)} ${fmtWhen(side)}` : side
  if (Array.isArray(side)) return side.join(', ')
  const o = side as Record<string, unknown>
  if (typeof o.caption === 'string') return o.caption || C.photoTitle
  if (typeof o.proposed === 'string') return `${o.label ?? ''}: ${o.proposed}`
  if (typeof o.title === 'string') return o.title
  if (typeof o.name === 'string') return o.name
  return JSON.stringify(side)
}
