import type { BoardPoint, LineAttachment, Trupp } from '../../types'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { toast } from '../ui'
import { objectAttachment } from '../lineAttachments'
import { lineTakesTrupp, resolveLinkNumber, truppForLine, truppIdForAttachment, type LinkableLine, type TruppMarker } from '../truppLines'
import { truppLogName } from '../atemschutz'
import { isOutTrupp, type TruppActionCore, type TruppActionDeps } from './core'
import type { TruppPlacementActions } from './placement'

// The Trupp LINES family — a Trupp and its Leitung: link / unlink from every door (form, line
// editor, marker menu, magnet), the number kept in sync, and the reads the card shows (which
// Leitung, is there one to jump to). Rules: lib/truppLines. Composed by lib/useTruppActions.

type LineDeps = Pick<TruppActionDeps, 'trupps' | 'setTrupps' | 'drawings' | 'entities' | 'board' | 'setBoard' | 'setDocRaw'
  | 'log' | 'emit' | 'setMode' | 'setActivePlanId' | 'setPanel' | 'setPlanFocus' | 'focusMapDrawing'>
  & Pick<TruppActionCore, 'updateTrupp'>
  /** a link settles the crew's marker at the hose end, placing one where there is none (settleAtHoseEnd) */
  & Pick<TruppPlacementActions, 'placeTruppOnMap' | 'placeTruppOnPlan'>

export function truppLineActions(deps: LineDeps) {
  const { trupps, setTrupps, drawings, entities, board, setBoard, setDocRaw, log, emit, setMode, setActivePlanId, setPanel, setPlanFocus, focusMapDrawing, updateTrupp, placeTruppOnMap, placeTruppOnPlan } = deps

  // the hose lines of each surface, in the shape the link resolution needs
  const docLines = (): LinkableLine[] => drawings.filter((d) => d.kind === 'line')
  const planLines = (planId: string): LinkableLine[] => (board[planId] ?? []).filter((a) => a.kind === 'draw')

  /** Every placed Trupp marker there is, BOTH surfaces in one list: a hose end may legitimately
   *  be docked onto an object in the other document (docs/tactical-objects.md), and the
   *  automatic join must read that marker just as well as a native one. */
  const truppMarkers = (): TruppMarker[] => [
    ...entities.filter((e) => e.kind === 'team'),
    ...Object.values(board).flat().filter((a) => a.kind === 'resource'),
  ]

  /**
   * Show the Leitung this Trupp works on — the counterpart of «auf Plan zeigen» for the hose.
   * Looks on the Lage first (that is where a Druckleitung is usually drawn), then across the
   * plans; resolution is the normal one, so a Trupp matched by NUMBER alone jumps just as well as
   * one that was explicitly picked. Returns false when nothing is drawn yet, so the caller can
   * keep the affordance off rather than offering a dead button.
   */
  const showTruppLine = (id: string): boolean => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return false
    const onMap = drawings.find((d) => d.kind === 'line' && truppForLine(d, [tr])?.id === tr.id)
    if (onMap) { setMode('map'); setPanel(null); focusMapDrawing(onMap.id); return true }
    for (const [planId, annos] of Object.entries(board)) {
      const anno = annos.find((a) => a.kind === 'draw' && truppForLine(a, [tr])?.id === tr.id)
      if (!anno) continue
      const [x, y, floor] = anno.pts?.[0] ?? [0.5, 0.5, anno.floor ?? 0]
      setMode('plans'); setActivePlanId(planId); setPanel(null)
      // `flash`: outline it, don't select it — same rule as the Lage (see focusMapDrawing)
      setPlanFocus({ x, y, floor: floor ?? anno.floor ?? 0, annoId: anno.id, flash: true, nonce: Date.now() })
      return true
    }
    return false
  }

  /**
   * The Leitung number each Trupp's DRAWN line currently carries.
   *
   * ⚠️ The number lives on the drawing; the Trupp's `lineNo` is a copy taken when the two were
   * linked (see linkTruppLine). Renumbering the hose syncs that copy going forward, but every
   * record written before — and every copy a merge from an older client brings back — keeps the
   * old number, and the Atemschutz card then said «Ltg 1» next to a hose tagged «Ltg 3». Read at
   * render time, the picture is the single source of truth and stale copies heal themselves.
   * The stored copy stays the fallback: a Trupp whose line was deleted keeps the number it was
   * on, which is what the record says happened.
   */
  const truppLineNos = (): Map<string, number> => {
    const lines = [...docLines(), ...Object.values(board).flat().filter((a) => a.kind === 'draw')]
    const out = new Map<string, number>()
    for (const l of lines) {
      if (l.lineNo == null) continue
      const t = truppForLine(l, trupps)
      if (t && !out.has(t.id)) out.set(t.id, l.lineNo)
    }
    return out
  }

  /** Which Trupps have a drawn Leitung to jump to — drives the card chip's affordance, so it is
   *  a button exactly when there is somewhere to go. */
  const truppsWithLine = (): Set<string> => {
    const lines = [...docLines(), ...Object.values(board).flat().filter((a) => a.kind === 'draw')]
    const out = new Set<string>()
    for (const t of trupps) if (lines.some((l) => truppForLine(l, [t])?.id === t.id)) out.add(t.id)
    return out
  }

  /**
   * Link a Trupp to a drawn hose line — ONE action, because it writes two collections: the Trupp
   * (anchor + number) and the drawing (mirror + the stamped number). Split across two call sites
   * the halves would drift apart under sync; every other link in here (annoId/planId, entityId)
   * follows the same rule.
   *
   * `lineId` may name a Lage drawing or a Plan annotation — the surface is inferred, so every
   * caller just hands over the hose it has: the line editor's «Gehört zu Trupp …», the Trupp
   * form's Ltg-Nr. quick-picks, and since 15.09. the automatic join through the picture
   * (linkLineToAttachedTrupp below, and a Trupp marker dropped on a hose's free end). An id that
   * is not a hose — an Absperrkreis, a Fläche, an entity — answers false and writes nothing.
   * Both writes go through the RAW setters, the
   * way placements do: the link is bookkeeping, not a drawing edit, and it has no business
   * sitting on the undo stack (Cmd-Z after linking would otherwise strip the stamped number and
   * leave the Trupp pointing at a line that no longer says which Leitung it is).
   */
  const linkTruppLine = (truppId: string, lineId: string): boolean => {
    const tr = trupps.find((t) => t.id === truppId)
    if (!tr) return false
    const az = appConfig.copy.atemschutz
    const onMap = docLines().some((l) => l.id === lineId)
    const planId = onMap ? null : Object.keys(board).find((pid) => (board[pid] ?? []).some((a) => a.id === lineId && a.kind === 'draw'))
    // not a hose (an Absperrkreis, a Fläche, a freehand scribble) — nothing to link
    if (!onMap && !planId) return false
    const lines = onMap ? docLines() : planLines(planId!)
    const line = lines.find((l) => l.id === lineId)!
    // ONE Trupp per Leitung (15.09., Bastian): a hose that already carries a crew still in the
    // field takes no second one – from the line editor, the marker menu or the magnet alike.
    // The form's own Ablösung path releases the holder FIRST (AtemschutzView · submitForm), so a
    // confirmed takeover still lands here with the line free.
    const holder = truppForLine(line, trupps)
    if (holder && holder.id !== truppId && !isOutTrupp(holder)) {
      toast(fillTemplate(az.lineHeldToast, { name: holder.name }), { tone: 'warn' })
      return false
    }
    const no = resolveLinkNumber(tr, line, lines, trupps)

    // the drawing: mirror + number. Any OTHER line that claimed this Trupp lets go, so a Trupp
    // is on exactly one Leitung (re-picking moves it instead of leaving two tagged hoses).
    const patchLine = <T extends { id: string; truppId?: string; lineNo?: number }>(l: T): T =>
      l.id === lineId ? { ...l, truppId, ...(no != null ? { lineNo: no } : {}) }
        : l.truppId === truppId ? { ...l, truppId: undefined } : l
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? patchLine(dr) : dr)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? patchLine(a) : a))])))
    // One Leitung, one Trupp: whoever else claims this number lets go of it, so picking a Trupp
    // for a hose can't quietly produce two Trupps on one Leitung. Their NEW fields are cleared —
    // a legacy free-text designation is never rewritten (an incident is a legal record).
    setTrupps((ts) => ts.map((t) => {
      if (t.id === truppId) return { ...t, lineId, ...(no != null ? { lineNo: no } : {}) }
      const claims = (no != null && t.lineNo === no) || (t.lineId && t.lineId === lineId)
      return claims && !isOutTrupp(t) ? { ...t, lineId: undefined, lineNo: undefined } : t
    }))

    log('drop', fillTemplate(az.logLineLinked, { name: truppLogName(tr, 'leader'), n: no != null ? String(no) : '–' }), 'team', undefined, undefined, { subjectId: truppId })
    emit('atemschutz.line.link', { id: truppId, lineId, lineNo: no })
    // no confirm toast (09.09.): the hose wears the Trupp tag the instant the link lands — the
    // ink is the confirmation, and the Verlauf row above is the record
    settleAtHoseEnd(tr, lineId, onMap ? null : planId!)
    return true
  }

  /**
   * Link = the marker AT the hose end (15.09., Bastian: «they're the same exact thing»). A Trupp
   * linked to a Leitung used to stand twice in the picture – its marker somewhere, and the
   * hose's end tag naming it again. Now every link, from whichever door (form quick-pick, line
   * editor, marker menu, snap, drop), ends with the Trupp's marker coupled to the hose's END:
   * an existing marker moves there (and lets go of any symbol it was docked to), a Trupp with
   * no marker on this surface gets one there. The end tag then never has a name to print.
   *
   * Nothing is written when the end already hangs on this very marker (the snap/drop doors
   * arrive that way), and nothing when it hangs on something ELSE – a crew is not put onto a
   * hydrant because its hose starts there; that end stays the operator's geometry.
   */
  const settleAtHoseEnd = (tr: Trupp, lineId: string, planId: string | null) => {
    // the coupling the endpoint magnet would have written (lib/lineAttachments · DEFAULT_OBJECT_ROUTING)
    const coupling = (id: string): LineAttachment => objectAttachment(id)
    if (!planId) {
      const line = drawings.find((d) => d.id === lineId && d.kind === 'line')
      if (!line || line.coords.length < 2) return
      const end = line.coords[line.coords.length - 1]
      const marker = entities.find((e) => e.kind === 'team' && e.truppId === tr.id)
      const a = line.endAttachment
      if (a && (a.target.kind !== 'object' || !marker || a.target.id !== marker.id)) return
      if (a) return
      let markerId = marker?.id
      if (marker) {
        // ⚠️ the APP moves the marker here, not a hand: a plan-drawn chip stays on its sheet and
        // takes the new spot through the fit (lib/useObjectStore · `gesture`)
        setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === marker.id ? { ...e, coord: end, dockedTo: undefined } : e)) }), { gesture: false })
        emit('entity.move', { id: marker.id, coord: end })
      } else markerId = placeTruppOnMap(tr.id, end)
      if (!markerId) return
      setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.id === lineId ? { ...dr, endAttachment: coupling(markerId) } : dr)) }))
      emit('draw.attach', { id: lineId, endpoint: 'end', attachment: coupling(markerId), fallback: end })
      return
    }
    const annos = board[planId] ?? []
    const line = annos.find((x) => x.id === lineId && x.kind === 'draw')
    if (!line?.pts || line.pts.length < 2) return
    const end = line.pts[line.pts.length - 1]
    const chip = annos.find((x) => x.kind === 'resource' && x.truppId === tr.id)
    const a = line.endAttachment
    if (a && (a.target.kind !== 'object' || !chip || a.target.id !== chip.id)) return
    if (a) return
    const spot = { x: end[0], y: end[1], floor: end[2] ?? line.floor ?? 0 }
    let chipId = chip?.id
    if (chip) {
      // …and the same on a sheet: a Karte marker lent to this sheet keeps its geo anchor
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((x) => (x.id === chip.id ? { ...x, ...spot } : x)) }), { gesture: false })
      emit('board.edit', { id: chip.id, patch: spot, planId })
    } else chipId = placeTruppOnPlan(tr.id, planId, spot)
    if (!chipId) return
    setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((x) => (x.id === lineId ? { ...x, endAttachment: coupling(chipId) } : x)) }), { gesture: false })
    emit('board.edit', { id: lineId, patch: { endAttachment: coupling(chipId) }, planId })
  }

  /**
   * A hose end just docked onto something — join the Leitung to the Trupp when that something is
   * a Trupp's marker. THE automatic link (15.09.2026): the explicit «Leitung wählen» tap mode is
   * gone, and coupling the hose to the crew in the picture is what says who works it. Both
   * surfaces call it with whatever their magnet just attached — a new stroke's end and an
   * endpoint dragged onto a marker are the same act.
   *
   * Everything else the magnet can dock onto (another Leitung's end, a Fahrzeug, a marker nobody
   * is standing on) answers `false` and writes nothing. Nor is there an inverse: pulling the end
   * off again is a picture edit, and the picture never touches the Trupp record (see the doctrine
   * at the top of lib/truppLines).
   *
   * ⚠️ FAILS CLOSED on a Leitung that already has a crew (lineTakesTrupp — «one Trupp per line»,
   * 15.09.): the hose still docks onto the marker, because that is geometry the operator drew,
   * but nobody is re-assigned. A takeover is a decision, and it is made in a LIST that asks first
   * (AtemschutzView · the Ltg-Nr. clash branch), never by a hose end swinging past a second crew.
   */
  const linkLineToAttachedTrupp = (lineId: string, attachment: LineAttachment | undefined): boolean => {
    const truppId = truppIdForAttachment(attachment, truppMarkers())
    if (!truppId) return false
    const line = docLines().find((l) => l.id === lineId)
      ?? Object.values(board).flat().find((a) => a.id === lineId && a.kind === 'draw')
    if (line && !lineTakesTrupp(line, trupps)) return false
    return linkTruppLine(truppId, lineId)
  }

  /**
   * The reverse of linkLineToAttachedTrupp (15.09.): a hose end let go of a Trupp's marker –
   * editor «Lösen» or dragged off – and the hose was that Trupp's Leitung, so the two part.
   * Only when the coupling that ends IS the one the link stands on: a hose linked by number to
   * a Trupp whose marker it never touched keeps its link. The Trupp record itself (clocks,
   * readings) is untouched – only the Leitung fields (unlinkTruppLine).
   */
  const unlinkLineFromDetachedTrupp = (lineId: string, previous: LineAttachment | undefined): boolean => {
    const truppId = truppIdForAttachment(previous, truppMarkers())
    if (!truppId) return false
    const line = docLines().find((l) => l.id === lineId)
      ?? Object.values(board).flat().find((a) => a.id === lineId && a.kind === 'draw')
    const tr = line ? truppForLine(line, trupps) : undefined
    if (!tr || tr.id !== truppId) return false
    unlinkTruppLine(tr.id)
    return true
  }

  /** Drop just the ANCHOR (both sides), keeping whatever number the Trupp carries. Used when the
   *  number is edited: the anchor was stamped FROM a number, so it must not outlive it — a Trupp
   *  moved from Leitung 1 to Leitung 3 would otherwise still point at the old hose. */
  const clearLineAnchor = (truppId: string) => {
    const drop = <T extends { truppId?: string }>(l: T): T => (l.truppId === truppId ? { ...l, truppId: undefined } : l)
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? drop(dr) : dr)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? drop(a) : a))])))
    updateTrupp(truppId, { lineId: undefined })
  }

  /**
   * The renumber direction of the link: a drawn Leitung got a NEW number, so the Trupp anchored
   * to it carries the number too. The Atemschutz chip prints the Trupp's OWN `lineNo` (a copy
   * stamped by linkTruppLine), so without this sync renumbering the drawing leaves the chip
   * naming a Leitung that no longer exists in the picture. Anchor match ONLY (line.truppId ⇄
   * Trupp.lineId, the same pair truppForLine resolves first) — never by number, or renumbering
   * would grab whichever Trupp merely typed the same digit («one Leitung = one Trupp»). A Trupp
   * that is out or removed keeps what it recorded, mirroring linkTruppLine's release guard.
   * Called from both renumber entry points (Lage DrawEditor, Plan DrawEditor via Whiteboard's
   * onLineRenumber); the drawing itself was already patched by the caller.
   */
  const syncLineNoToTrupp = (lineId: string, lineNo: number | undefined) => {
    const line = docLines().find((l) => l.id === lineId)
      ?? Object.values(board).flat().find((a) => a.id === lineId && a.kind === 'draw')
    // ⚠️ A `raus` Trupp still syncs — its card keeps showing the Leitung chip, and that chip
    // said «Ltg 1» next to a hose tagged «Ltg 3» (19.08.). Only a soft-deleted card is skipped;
    // the release-guard from linkTruppLine protects claims, not a number that must stay true.
    const tr = trupps.find((t) =>
      ((line?.truppId && t.id === line.truppId) || (t.lineId && t.lineId === lineId))
      && !t.removedAt)
    if (!tr || tr.lineNo === lineNo) return
    updateTrupp(tr.id, { lineNo })
    emit('atemschutz.line.renumber', { id: tr.id, lineId, lineNo })
  }

  /**
   * Let go of the Leitung. Clears the anchor on BOTH sides and the Trupp's own number — dropping
   * only the anchor would leave the number match to re-attach the tag on the very next render,
   * so «gelöst» would visibly do nothing. The drawn line keeps its number: the hose is still
   * Leitung 1 in the picture, it just has nobody on it.
   */
  const unlinkTruppLine = (truppId: string) => {
    const tr = trupps.find((t) => t.id === truppId)
    if (!tr) return
    const drop = <T extends { truppId?: string }>(l: T): T => (l.truppId === truppId ? { ...l, truppId: undefined } : l)
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? drop(dr) : dr)) }), { gesture: false })
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? drop(a) : a))])), { gesture: false })
    updateTrupp(truppId, { lineId: undefined, lineNo: undefined })
    // …and the hose lets go of the Trupp's marker/chip (15.09.): link and coupling are ONE fact
    // (settleAtHoseEnd), so «Kein Trupp» from the line editor, the marker menu or the pill's
    // «Lösen» must part the picture too, or the hose kept following a crew it no longer had.
    // The end stays where the marker stands. ⚠️ Both writes below are the APP's (`gesture:
    // false`): the freed end is put where the marker stood, which is no placement, and read as one
    // it tore a plan-drawn hose off its sheet (or a Karte hose onto one).
    const marker = entities.find((e) => e.kind === 'team' && e.truppId === truppId)
    if (marker) {
      setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => {
        if (dr.kind !== 'line') return dr
        let next = dr
        for (const ep of ['start', 'end'] as const) {
          const a = ep === 'start' ? next.startAttachment : next.endAttachment
          if (a?.target.kind !== 'object' || a.target.id !== marker.id || next.coords.length < 2) continue
          const coords = next.coords.map((c, i) => (i === (ep === 'start' ? 0 : next.coords.length - 1) ? marker.coord : c))
          next = { ...next, coords, ...(ep === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
          emit('draw.detach', { id: dr.id, endpoint: ep, fallback: marker.coord })
        }
        return next
      }) }), { gesture: false })
    }
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) => {
      const chip = annos.find((a) => a.kind === 'resource' && a.truppId === truppId)
      if (!chip) return [pid, annos]
      return [pid, annos.map((a) => {
        if (a.kind !== 'draw' || !a.pts?.length) return a
        let next = a
        for (const ep of ['start', 'end'] as const) {
          const rel = ep === 'start' ? next.startAttachment : next.endAttachment
          if (rel?.target.kind !== 'object' || rel.target.id !== chip.id) continue
          const at: BoardPoint = [chip.x ?? 0, chip.y ?? 0, chip.floor ?? 0]
          const pts = next.pts!.map((q, i): BoardPoint => (i === (ep === 'start' ? 0 : next.pts!.length - 1) ? at : q))
          next = { ...next, pts, ...(ep === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }
          emit('board.edit', { id: a.id, patch: { pts, ...(ep === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }) }, planId: pid })
        }
        return next
      })]
    })), { gesture: false })
    log('drop', fillTemplate(appConfig.copy.atemschutz.logLineUnlinked, { name: truppLogName(tr, 'leader') }), 'team', undefined, undefined, { subjectId: truppId })
    emit('atemschutz.line.unlink', { id: truppId })
  }

  /** The same gesture from the LINE's side («Gehört zu Trupp …» → «Kein Trupp»): whoever is on
   *  this hose lets go of it. Resolved through truppForLine so it also releases a Trupp that only
   *  ever matched by number — otherwise the picker would show «Kein Trupp» while the tag stayed. */
  const unlinkLine = (lineId: string) => {
    const line = docLines().find((l) => l.id === lineId)
      ?? Object.values(board).flat().find((a) => a.id === lineId && a.kind === 'draw')
    const tr = line ? truppForLine(line, trupps) : undefined
    if (tr) unlinkTruppLine(tr.id)
  }

  return { linkTruppLine, linkLineToAttachedTrupp, unlinkLineFromDetachedTrupp, unlinkTruppLine, unlinkLine, clearLineAnchor, syncLineNoToTrupp, showTruppLine, truppsWithLine, truppLineNos }
}

export type TruppLineActions = ReturnType<typeof truppLineActions>
