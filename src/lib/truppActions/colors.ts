import type { Trupp } from '../../types'
import { appConfig } from '../../config/appConfig'
import { pickTeamColor } from '../teamColors'
import { atemschutzAuftragColors } from '../deploymentConfig'
import type { TruppActionDeps } from './core'

// The colour a Trupp WEARS — on its placed marker / plan chip and on the board's card. Composed
// by lib/useTruppActions; placement paints with `teamColor`, edits repaint with `recolorPlacement`.

type ColorDeps = Pick<TruppActionDeps, 'trupps' | 'entities' | 'board' | 'setBoard' | 'setDocRaw'>

export function truppColorActions(deps: ColorDeps) {
  const { trupps, entities, board, setBoard, setDocRaw } = deps

  // The Trupp's own palette slot — its index in the list, so plan chip and map marker match and
  // a Trupp keeps the colour people have got used to. Whether it actually GETS that colour is
  // decided at placement by pickTeamColor, which steps aside if something already wears it.
  const preferredColor = (id: string) => {
    const colors = appConfig.drawing.teamColors
    return colors[Math.max(0, trupps.findIndex((t) => t.id === id)) % colors.length]
  }
  /**
   * A colour someone DECIDED on for this Trupp, in the order those decisions were made: the
   * Trupp's own pick first, then the station's colour for its Auftrag. Undefined = nobody decided,
   * so the automatic palette applies.
   *
   * A chosen colour is used verbatim — it deliberately does NOT go through pickTeamColor. That
   * helper exists to keep automatic colours apart from one another; applying it here would quietly
   * refuse «alle Löschtrupps rot», which is exactly what choosing a colour is for.
   */
  const chosenColor = (tr?: Trupp): string | undefined =>
    tr?.color || (tr?.auftrag ? atemschutzAuftragColors()[tr.auftrag] : undefined) || undefined
  /** every colour currently worn by a placed marker or plan chip — what a new placement must
   *  not duplicate. Reads the live doc/board rather than a counter, so deleting a Trupp frees
   *  its colour again instead of shifting everyone else's. */
  const colorsInUse = (exceptTruppId?: string): (string | undefined)[] => [
    ...entities.filter((e) => e.kind === 'team' && e.truppId !== exceptTruppId).map((e) => e.color),
    ...Object.values(board).flat().filter((a) => a.kind === 'resource' && a.truppId !== exceptTruppId).map((a) => a.color),
  ]
  const teamColor = (id: string) =>
    chosenColor(trupps.find((t) => t.id === id)) ?? pickTeamColor(preferredColor(id), colorsInUse(id))

  /** Repaint a Trupp's placed marker / plan chip after its colour (or the Auftrag that decides it)
   *  changed. No-op when it isn't placed. */
  const recolorPlacement = (tr: Trupp) => {
    if (!tr.annoId && !tr.entityId) return
    syncPlacementColor(tr, chosenColor(tr) ?? pickTeamColor(preferredColor(tr.id), colorsInUse(tr.id)))
  }
  /** Repaint a Trupp's placed marker / plan chip — the twin of syncPlacementLabel, for when the
   *  colour (or the Auftrag that decides it) changes on an already-placed Trupp. */
  const syncPlacementColor = (tr: Trupp, color: string) => {
    if (tr.annoId && tr.planId) {
      const { annoId, planId } = tr
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((a) => (a.id === annoId ? { ...a, color } : a)) }))
    }
    if (tr.entityId) {
      const { entityId } = tr
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === entityId ? { ...e, color } : e)) }))
    }
  }

  /**
   * The colour each Trupp actually WEARS right now — for the Atemschutz board, so a card and its
   * symbol on the Lage read as the same Trupp.
   *
   * EVERY Trupp gets one. In order of authority: the placed marker/chip (it is what the operator
   * is looking at), then a colour somebody decided (own pick / station colour for the Auftrag),
   * then the automatic palette slot. That last case used to be left BLANK — the reasoning being
   * that an automatic colour is only settled at placement, so showing one early could show the
   * wrong one. In practice it meant the board's colour column was full of holes: a Trupp that
   * had simply never been placed had no dot, which reads as «this one has no colour» rather than
   * «not decided yet», and on a board where colour IS identity that is the more misleading of
   * the two. The guess is also not much of a guess: it runs the same `preferredColor` slot
   * through the same `pickTeamColor` the placement will use, so placing a Trupp normally
   * confirms the colour it was already wearing.
   *
   * ⚠️ The running `used` set is what keeps the unplaced ones APART. Asked one at a time they
   * would every one of them get the first free colour — ten Trupps, one colour, which is the
   * exact failure pickTeamColor exists to prevent.
   */
  const truppColors = (): Record<string, string> => {
    const out: Record<string, string> = {}
    const used: string[] = []
    // decided colours are claimed FIRST, before any automatic one is handed out — otherwise the
    // automatic pass could take the colour a later Trupp already wears by decision
    for (const t of trupps) {
      const placed = t.entityId ? entities.find((e) => e.id === t.entityId)?.color
        : t.annoId && t.planId ? (board[t.planId] ?? []).find((a) => a.id === t.annoId)?.color
        : undefined
      const c = placed ?? chosenColor(t)
      if (c) { out[t.id] = c; used.push(c) }
    }
    for (const t of trupps) {
      if (out[t.id]) continue
      const c = pickTeamColor(preferredColor(t.id), used)
      out[t.id] = c
      used.push(c)
    }
    return out
  }

  return { teamColor, recolorPlacement, truppColors }
}

export type TruppColorActions = ReturnType<typeof truppColorActions>
