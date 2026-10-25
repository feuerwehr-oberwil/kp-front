// Removing objects from the Plan: «Entfernen» with the Leitungen coupled to the object let go where
// they stand (lib/lineAttachments · detachEnds — the Karte's useMapActions · deleteEntity runs the
// same fold), «Marker und Spur löschen», the Mehrfach group delete, and the Delete key. Each act
// is ONE ↶ step and ONE Verlauf row. Lifted out of the Whiteboard (sweep A.1, 25.10.2026).

import { useEffect } from 'react'
import type React from 'react'
import type { BoardAnno } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { confirmDialog } from '../lib/ui'
import { detachEnds } from '../lib/lineAttachments'
import { annoLogName } from '../lib/drawingEdit'
import type { useBoardDoc } from './useBoardDoc'
import type { PlanLogExtra } from './Whiteboard'

interface Args {
  readOnly: boolean
  annos: BoardAnno[]
  /** the annos with every attached line end resolved to where it sits on screen now */
  renderAnnos: BoardAnno[]
  selId: string | null
  setSelId: (id: string | null) => void
  selIds: string[]
  setSelIds: React.Dispatch<React.SetStateAction<string[]>>
  /** what the selection bar is pointed at (useWbSelectionBar) — the Delete key reaches for it */
  barIds: string[]
  removeAnno: ReturnType<typeof useBoardDoc>['removeAnno']
  commit: (next: BoardAnno[]) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  activeId: string
  /** arm / disarm the incident writing this chip's ghost trail deleted (Whiteboard · Props.onTrailDrop) */
  onTrailDrop?: (annoId: string, on: boolean) => void
}

/** The Plan's removals; see the file header. Called where the Delete key's listener always
 *  registered, below the selection bar. */
export function usePlanRemoval({ readOnly, annos, renderAnnos, selId, setSelId, selIds, setSelIds, barIds, removeAnno, commit, emit, log, activeId, onTrailDrop }: Args) {
  // ⚠️ A trail no longer LOCKS its chip (18.09.2026). The record is protected by outliving the
  // marker instead: a removed chip's recorded positions move into a ghost trail the incident
  // owns (lib/truppTrails · reconcileGhostTrails, driven from IncidentWorkspace), so the trash
  // always does the one thing it says and the searched area is still on the sheet afterwards.
  /**
   * «Entfernen» on the plan writes the Karte's removal row (review item 21b, 24.09.2026) —
   * «{name} gelöscht» (`log.objectDeleted`), named the way the Karte names the same object
   * (lib/drawingEdit · annoLogName) and carrying it as its SUBJECT, never as a jump target: the
   * object is gone. It used to write nothing for a single object, so a Feuer deleted on the EG
   * left no trace in the Verlauf at all. ONE act, ONE row: the store fold writes none, and a
   * group of several keeps its «n Objekte vom Plan gelöscht». An empty Notiz writes none, as on
   * the Karte.
   */
  const logRemoved = (a: BoardAnno) => {
    const name = annoLogName(a)
    if (name == null) return
    log('close', fillTemplate(appConfig.copy.log.objectDeleted, { name }), { subjectId: a.id })
  }

  // returns whether the object actually went — «Marker und Spur löschen» has to take its arming
  // back when the connection question (or the note question) was answered with «Abbrechen»
  const removeWithConnections = async (target: BoardAnno): Promise<boolean> => {
    const affected = annos.flatMap((a) => (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && ((rel.target.kind === 'object' && rel.target.id === target.id) || (rel.target.kind === 'line' && rel.target.id === target.id)) ? [{ a, endpoint, rel }] : []
    }))
    if (!affected.length) {
      const gone = await removeAnno(target)
      if (gone) logRemoved(target)
      return gone
    }
    const ok = await confirmDialog({
      title: fillTemplate(appConfig.copy.drawingEditor.removeConnectedTitle, { name: target.label ?? target.text ?? appConfig.copy.drawingEditor.drawing }),
      message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }),
      confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return false
    const changed = new Set(affected.map((x) => x.a.id))
    // each coupled end lets go where it stands on screen now (lib/lineAttachments · detachEnds) —
    // the ONE fold the commit and the per-line audit events below both read
    const detached = (a: BoardAnno) => detachEnds({ ...a, points: a.pts ?? [] }, (endpoint, rel, pts) => {
      if (rel.target.id !== target.id) return null
      const resolvedSource = renderAnnos.find((x) => x.id === a.id)?.pts
      return resolvedSource?.[endpoint === 'start' ? 0 : resolvedSource.length - 1] ?? pts[endpoint === 'start' ? 0 : pts.length - 1]
    })
    commit(annos.filter((a) => a.id !== target.id).map((a) => {
      const out = a.pts?.length ? detached(a) : null
      return out ? { ...a, pts: out.points, ...out.freed } : a
    }))
    emit('board.delete', { id: target.id, planId: activeId })
    logRemoved(target)
    changed.forEach((id) => {
      const source = annos.find((a) => a.id === id)
      if (!source?.pts) return
      const out = detached(source)
      const next = out ? { ...source, pts: out.points, ...out.freed } : source
      emit('board.edit', { id, patch: { pts: next.pts, startAttachment: next.startAttachment, endAttachment: next.endAttachment }, planId: activeId })
    })
    if (selId === target.id) setSelId(null)
    return true
  }

  /**
   * «Marker und Spur löschen» — the third row of the chip's trash menu (components/TwinTeamPill).
   * Both go, and unlike a plain removal NOTHING is left behind: the incident is armed first
   * (`onTrailDrop`), so the reconciliation writes this chip's ghost already `removedAt`-stamped
   * instead of standing the searched area back up (lib/truppTrails). It stays ONE undo step —
   * the chip's own removal — because nothing but that removal was ever committed.
   */
  const removeWithTrail = async (a: BoardAnno) => {
    if (a.kind !== 'resource' || !a.trail?.length) return
    // a trail is never destroyed without the ask, wherever the door is (Karte parity)
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.removeMarkerTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: a.text ?? '', n: a.trail.length }),
      confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    onTrailDrop?.(a.id, true)
    if (!await removeWithConnections(a)) { onTrailDrop?.(a.id, false); return }
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: a.text ?? '' }))
  }

  // group delete — removes the whole selection; a trail-carrying team goes with it and leaves
  // its ghost trail behind (see removeWithConnections).
  const deleteGroup = async () => {
    if (readOnly) return
    const removable = selIds.filter((id) => annos.some((x) => x.id === id))
    if (!removable.length) return
    const affected = annos.flatMap((a) => removable.includes(a.id) ? [] : (['start', 'end'] as const).flatMap((endpoint) => {
      const rel = endpoint === 'start' ? a.startAttachment : a.endAttachment
      return rel && removable.includes(rel.target.id) ? [{ a, endpoint, rel }] : []
    }))
    if (affected.length) {
      const ok = await confirmDialog({ title: appConfig.copy.whiteboard.groupDeleteTitle, message: fillTemplate(appConfig.copy.drawingEditor.removeConnectedMessage, { n: affected.length }), confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    commit(annos.filter((a) => !removable.includes(a.id)).map((a) => {
      if (!a.pts?.length) return a
      const out = detachEnds({ ...a, points: a.pts }, (endpoint, rel, pts) => {
        if (!removable.includes(rel.target.id)) return null
        const resolvedSource = renderAnnos.find((x) => x.id === a.id)?.pts
        return resolvedSource?.[endpoint === 'start' ? 0 : resolvedSource.length - 1] ?? pts[endpoint === 'start' ? 0 : pts.length - 1]
      })
      return out ? { ...a, pts: out.points, ...out.freed } : a
    }))
    removable.forEach((id) => emit('board.delete', { id, planId: activeId }))
    setSelIds((ids) => ids.filter((id) => !removable.includes(id)))
    setSelId(null)
    const lone = removable.length === 1 ? annos.find((a) => a.id === removable[0]) : undefined
    if (lone) { logRemoved(lone); return }
    log('close', removable.length > 1
      ? fillTemplate(appConfig.copy.whiteboard.groupDeletedN, { n: removable.length })
      : appConfig.copy.whiteboard.groupDeleted)
  }

  /** Remove whatever the bar is pointed at — a Mehrfach group, a single Linie/Fläche/
   *  Absperrkreis, a Form, and the mirrored members of any of those (which delete through their
   *  ONE source object on the Karte).
   *  ⚠️ No longer reachable FROM the bar (02.09.): this is what the Delete key runs, and what an
   *  object's own editor sheet runs. The bar's third slot is «Fertig». */
  const deleteSelection = () => {
    if (readOnly) return
    if (selIds.length > 1) { void deleteGroup(); return }
    const a = annos.find((x) => barIds.includes(x.id))
    if (a) void removeWithConnections(a)
  }

  /**
   * Delete / Backspace removes the current selection — the Karte's key, now on the Kroki too
   * (A21). It reaches for exactly what the bar's trash reaches for: a Mehrfach group, a single
   * Linie/Fläche/Absperrkreis, a Form, and the mirrored members of any of those (which delete
   * through their one source object). A selected symbol / Notiz / Truppmarker never gets the bar,
   * so it goes the way its own panel deletes it — `removeWithConnections`, which is also what
   * keeps a trail-carrying Trupp protected and asks before an attached line is cut loose.
   *
   * ⚠️ Never while a field owns the press. On a sheet full of Notiz textareas and Trupp names
   * Backspace is a character far more often than it is a delete, and the target — not
   * activeElement — is what still names the field once its own handler has blurred (same reason
   * as the Escape listener above).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (readOnly) return
      if (barIds.length) { e.preventDefault(); deleteSelection(); return }
      const a = annos.find((x) => x.id === selId)
      if (a) { e.preventDefault(); void removeWithConnections(a) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `annos` is a dep so the delete closes over the live document, as on the Karte
  }, [annos, selId, selIds, barIds, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  return { removeWithConnections, removeWithTrail }
}
