/** The selected Truppmarker's pill + context bar — the ONE copy, for all four places it shows.
 *
 *  Twin doctrine: a projection carries the same capabilities through the same functions its
 *  original has — rename, Trupp-Join, Farbe, «Position markieren», the Spuren-Auge, the
 *  delete rows — plus the one door a projection alone needs, «zum Original». That bar used to be
 *  written out four times: twice for the mirrors and once inside each NATIVE surface
 *  (MapMarkers' Trupp marker, Whiteboard's resource chip). The mirrors had already drifted once
 *  — the Plan carried the whole bar, the Karte a bare dot and a read-only plaque — so the same
 *  Trupp answered differently depending on which picture you were looking at. Since 03.09. all
 *  four render THIS component, so there is nothing left to drift.
 *
 *  It is deliberately free of every surface's coordinate system: the caller supplies the
 *  marker's facts, the writers that land on its ONE source object, and a `hit` shell that owns
 *  the surface's own tap/drag gesture around the pill.
 *
 *  What a surface says by LEAVING A WRITER OUT is «this door is not mine to open»: an action
 *  that is absent draws no button. That is how the plan board keeps its chip colour in the
 *  SelectionBar (no swatch here), and how a read-only Karte shows the pill with no bar at all.
 *
 *  The card and the bar DOCK at the foot of the screen (round 18.11.2026, owner pick M1 A on the
 *  phone, A «✥ ⟳ twin» on tablet + desktop the same day): beside the marker they hung right of the
 *  dot, ran off the screen and covered the Lage. The bar stands in the ✥ ⟳ bar's slot, the card –
 *  name, state, storey, time and a ✕ – on top of it (09-whiteboard · `.wb-pill-dock`; on a phone
 *  the floating row's and the tool bar's slots, which step aside for it – 15-mobile). On the
 *  surface only the ringed name stays. Both are portaled into the SURFACE (`DOCK_HOST`): out of
 *  the marker's transform, which would pin a `fixed` box to the marker, and still inside the
 *  surface, so a Karte hidden behind a Plan hides its dock with it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { leaveOnEnter } from '../lib/fieldKeys'
import { Menu, type MenuActionItem } from '../lib/overlays'
import { MenuPick } from './MenuPick'
import { appConfig } from '../config/appConfig'
import { floorBadge } from '../lib/symbolRender'
import { floorLabel } from '../lib/whiteboard'
import type { LineTone, TeamLineBadge } from '../lib/truppLines'
import { truppStateWord } from './truppCardText'
import { useRailLabels } from '../lib/useDevicePrefs'
import type { Trupp } from '../types'

/**
 * The join sheet — «welcher Trupp ist dieser Marker?» — of a selected Trupp marker (Karte) or
 * chip (Plan): the marker's half of the join, in the exact shape the line editor's «Gehört zu
 * Trupp …» has (the app's own menu, never a native <select>). ONE list for both surfaces:
 * «Kein Trupp», then every registered Trupp that is not out — an out one only when it is the one
 * standing here (it is the record of who WAS, not somebody to send). A Trupp registered AFTER
 * the marker was put down is in the list, so a «Trupp 2» dropped at 03:12 still finds its crew
 * at 03:14. Takeover of somebody else's chip asks first, in the ONE place that ask lives
 * (useTruppActions · adoptTruppMarker).
 *
 * ⚠️ Always drawn wherever the surface offers `pick` (14.09.). It used to be withheld while no
 * Trupp was joinable yet, which in the field read as «the join option is sometimes missing» —
 * the button is the door, whether or not anyone is behind it right now.
 *
 * «Neuer Trupp» (14.09.) is the LAST row, wherever the surface offers `create`: it opens the
 * normal Anmeldung, and saving it joins the new Trupp to THIS marker in the same go — the picture
 * was there first, the record comes second, and nobody has to find the chip again from the card.
 * Cancel leaves the loose chip as it was. Both surfaces render this one function, so the row
 * exists here and nowhere else.
 */
export function TruppJoinMenu({ truppId, trupps, pick, create, onNone, word }: TruppJoinProps & {
  /** the bar's word under the glyph (TwinTeamPill · `barWord`) – absent with «Beschriftung» off */
  word?: ReactNode
}) {
  return (
    <Menu
      popupClassName="de-menu-pop"
      itemClassName={() => 'de-menu-item'}
      trigger={
        // the join's own glyph, the link (rare-user round 2, M12): the stopwatch is «Zum Trupp»'s,
        // the Trupps page's door, and the two used to stand side by side wearing the same one
        <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
          <Icon id="link" />{word}
        </button>
      }
      items={truppJoinItems({ truppId, trupps, pick, create, onNone })}
    />
  )
}

interface TruppJoinProps {
  truppId?: string; trupps: Trupp[]; pick: (truppId?: string) => void; create?: () => void
  /** «Kein Trupp» exists only on a marker that hangs on a hose (15.09., Bastian): it takes the
   *  marker off the Leitung – hose unlinked and uncoupled, marker a step away, still this Trupp's.
   *  A marker on nothing has no such entry; leaving the picture is the trash can. */
  onNone?: () => void
}

/** The join sheet's rows – ONE list, drawn by the bar's «Atemschutz-Trupp» button and, on a linked
 *  marker, by the same row inside «Mehr» (TwinTeamPill). */
function truppJoinItems({ truppId, trupps, pick, create, onNone }: TruppJoinProps): MenuActionItem[] {
  return [
    ...(onNone ? [{ label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={false} />, onClick: onNone }] : []),
    ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === truppId)).map((t) => ({
      label: <MenuPick label={t.name} on={t.id === truppId} />,
      onClick: () => pick(t.id),
    })),
    // an ACTION row: its «+» leads, where an action's glyph stands – the picks' ✓ is trailing
    // (MenuPick, duck sweep ELEM.7), so a lit glyph in a tick's slot no longer reads «picked»
    ...(create ? [{
      label: <><span className="de-menu-lead" aria-hidden><Icon id="plus" /></span><span>{appConfig.copy.whiteboard.newTeam}</span></>,
      onClick: create,
    }] : []),
  ]
}

/** Every write the bar makes, each landing on the ONE source object the twin mirrors.
 *  An OPTIONAL writer is a door this surface does not offer — its button is not drawn. */
export interface TwinTeamActions {
  rename?: (name: string) => void
  pick?: (truppId?: string) => void
  /** «Neuer Trupp» on the join sheet — register a Trupp that adopts this marker on save */
  newTrupp?: () => void
  mark?: () => void
  /** «Spur löschen» — the marker stays, its recorded positions go. Confirms on the surface. */
  clearTrail?: () => void
  /** «Marker entfernen» — the trail it walked stays behind as a ghost (lib/truppTrails). Absent
   *  on a locked surface's bar, which keeps only «Im Atemschutz zeigen» and «Spur ein/aus»:
   *  then «Mehr» has no delete rows at all. */
  remove?: () => void
  /** «Marker und Spur löschen» — both at once, and NO ghost is left standing: the surface arms
   *  the reconciliation's `dropped` set before it removes, so the ghost is born already stamped
   *  (lib/truppTrails). Absent ⇒ the row is not offered, like every other writer here. */
  removeWithTrail?: () => void
  showTrupp?: (truppId: string) => void
  toggleTrail?: () => void
  /** let go of the Leitung this Trupp is on (Karte, 15.09.). Offered only where a `line` badge is
   *  also drawn — a surface that does not show the join does not offer to break it. */
  unlink?: () => void
  /** let go of the symbol the marker is docked to (lib/docking) – the same act as the host panel's
   *  «Lösen» (useMapActions · undockTeam). Passed only while the marker IS docked. */
  undock?: () => void
}

/** Where the docked card + bar are portaled: the surface the marker is drawn on – the
 *  Plan's board, or the Karte's map container (outside its canvas container, so MapLibre's own
 *  gestures never see a press on the card). */
const DOCK_HOST = '.whiteboard, .maplibregl-map'

export function TwinTeamPill({ name, time, color, raus, truppId, floor, tone = 'idle', trailCount, trailShown, trupps, line, acts, hit, renameRef, renaming: renamingProp, onRenaming, onClose }: {
  name: string
  time?: string
  /** the colour actually painted (the source's own, or the palette's first) */
  color: string
  raus: boolean
  truppId?: string
  /** The storey this Trupp is working on — the Gebäude tile its chip sits on, or the `floor` its
   *  map body was baked with (18.09.2026). Drawn as the SAME signed badge a Leitung wears
   *  (`Drawing.floorTag`, lib/symbolRender · floorBadge): «wo ist Trupp 3» is answered on the
   *  picture, and on a floor stack the tile alone only says it to whoever is looking at that
   *  tile. ABSENT on a Trupp placed straight onto the Karte — it is on no storey, and a «0»
   *  there would assert an EG nobody stated. */
  floor?: number
  /** the Trupp's alarm tier (lib/truppLines · truppMarkerTone): `warn` / `crit` tint the pill the
   *  board's amber / red, the same tier its resting dot and its Leitung's tag wear (ENT.1) */
  tone?: LineTone
  trailCount: number
  trailShown: boolean
  trupps: Trupp[]
  /** The Leitung this Trupp works (Karte only): the coupling stub in the hose's own ink where
   *  the hose actually ends here, and «Lösen». ⚠️ No number field since 11.10.2026 (owner: the
   *  Karte's pill is the Gebäude chip's — just the name); the hose's end tag carries the number.
   *  OPTIONAL on purpose: the Plan and both mirrors pass nothing and render exactly as they did
   *  (lib/truppLines · teamLineBadges). */
  line?: TeamLineBadge
  /** absent = pill only, no bar — a surface that may look but not write (read-only Karte,
   *  a plan board in a drawing tool) still shows the selected pill exactly as before */
  acts?: TwinTeamActions
  /** the surface's own hit shell — it owns the press (drag on this surface, tap to keep the
   *  selection) and wraps the pill markup untouched. A surface whose own container already
   *  carries the gesture (both natives) leaves it out and the pill is rendered bare. */
  hit?: (children: ReactNode) => ReactNode
  /** the surface's focus recipe for the rename input, where a plain autoFocus is not enough —
   *  ⚠️ MapLibre's Marker preventDefaults mousedown ("prevent focusing on click"), so the Karte
   *  has to stop that event on the input itself or the field never takes focus. */
  renameRef?: (el: HTMLInputElement | null) => void
  /** a surface that can open the rename from OUTSIDE this bar drives the flag itself — the plan
   *  board's double-click on a chip is the one such door. Leave both out (the Karte, both
   *  mirrors: «Mehr › Bearbeiten» only) and the pill keeps the flag, since leaving the pill IS the commit. */
  renaming?: boolean
  onRenaming?: (on: boolean) => void
  /** the docked card's ✕: the selection ends. Absent ⇒ no ✕ (a tap beside still ends it). */
  onClose?: () => void
}) {
  // inline rename («Mehr › Bearbeiten») — the same grammar every surface uses
  const [selfRenaming, setSelfRenaming] = useState(false)
  // the dock (header): found from the pill once it is in the DOM, before the first paint. A pill
  // drawn outside a surface (a unit test's bare marker) keeps card and bar on the marker.
  const pillRef = useRef<HTMLSpanElement>(null)
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const host = pillRef.current?.closest<HTMLElement>(DOCK_HOST)
    if (host) setDockHost(host)
  }, [])
  const docked = !!dockHost
  const renaming = renamingProp ?? selfRenaming
  /* The field is CONTROLLED since 18.09.2026, for the ✕ beside it: a `defaultValue` input cannot
     be emptied from the outside, and «Trupp Nord 2» is exactly the kind of free-text name that
     gets rewritten rather than corrected (the reason ClearableInput exists — its 44px ✕ and its
     form geometry do not fit a 76px field on the map, so this is the same idea at pill size). */
  const [draft, setDraft] = useState(name)
  // seeded when the edit OPENS, not on every name change: a rename landing from sync mid-edit
  // must not overwrite what is being typed here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (renaming) setDraft(name) }, [renaming])
  const setRenaming = onRenaming ?? setSelfRenaming
  const rename = acts?.rename
  const pick = acts?.pick
  const newTrupp = acts?.newTrupp
  const showTrupp = acts?.showTrupp
  const mark = acts?.mark
  const toggleTrail = acts?.toggleTrail
  const unlink = acts?.unlink
  const undock = acts?.undock
  /* ── The bar (rare-user round 2, owner pick M12 A, 17.11.2026) ── the daily doors stand, the rest
     is behind «Mehr»: ONE Trupp button that changes – «Zum Trupp» on a linked marker, «Atemschutz-
     Trupp» (join) on a loose one, never both side by side – then «Markieren», then «Lösen» while the
     marker hangs on something (a Leitung, a symbol, or both – round 18.11.2026 evening, owner: «when
     joined, also always show the unjoin button»; on the bar, not the card: at 390 px a framed
     «Lösen» on the card cut the name to «Ko…»), then «Mehr». «Mehr»
     holds, as glyph + full word: Atemschutz-Trupp (change the link, linked only) ·
     Bearbeiten (rename, loose only) · Spuren ✓ · the delete rows, last.
     Same on phone and tablet; one row at 390 px in every state. «Beschriftung» (the rails' setting)
     only decides the LOOK: on, every button wears its word under the glyph; off, the same buttons
     are bare glyphs. The `aria-label`s carry the full words either way. */
  const worded = useRailLabels() === 'short'
  const barWord = (w: string) => worded ? <span className="wb-pa-word">{w}</span> : null
  const W = appConfig.copy.whiteboard
  const releaseWord = appConfig.copy.contextPanel.dockedRelease
  const zumTrupp = truppId && showTrupp ? truppId : undefined
  const onNone = line && unlink && truppId ? unlink : undefined
  const join = pick ? { truppId, trupps, pick, create: newTrupp, onNone } : undefined
  /** «Mehr» shows its rows, or – after its «Atemschutz-Trupp» row – the join list in their place
   *  (the app's Menu has no submenus; the row keeps the menu open and swaps what it lists) */
  const [morePage, setMorePage] = useState<'rows' | 'join'>('rows')
  const lead = (icon: string) => <span className="de-menu-lead" aria-hidden><Icon id={icon} /></span>
  // «Lösen» (15.09.): the one explicit way to part the marker from what it hangs on – its Leitung,
  // the symbol it is docked to, or both at once. Absent while it hangs on nothing.
  const release = onNone || undock ? () => { onNone?.(); undock?.() } : undefined
  const moreRows: MenuActionItem[] = [
    // re-point a linked marker to another Trupp – on a loose marker the bar's own button does it
    ...(zumTrupp && join ? [{
      label: <>{lead('link')}<span>{appConfig.copy.atemschutz.markerLabel}</span></>,
      onClick: () => setMorePage('join'), keepOpen: true,
    }] : []),
    // rename – a Trupp-bound marker is named by the Atemschutz board, so it has none: renaming it
    // here would fork the two names apart
    ...(!truppId && rename ? [{ label: <>{lead('pen')}<span>{appConfig.copy.edit}</span></>, onClick: () => setRenaming(true), keepsFocus: true }] : []),
    // per-team visibility toggle, NOT deletion. Its name is the CONTROL («Spuren») with the menu's
    // ✓ while shown, never the next action (duck sweep ELEM.5)
    ...(trailCount > 0 && toggleTrail ? [{ label: <>{lead('eye')}<MenuPick label={W.trails} on={trailShown} /></>, onClick: toggleTrail }] : []),
    /* ONE trash (18.09.2026), always last: the marker alone (its trail stays behind as a ghost the
       incident owns, lib/truppTrails), and where it carries a Spur also the trail alone or both –
       two danger rows that each confirm on the surface before anything is destroyed. */
    ...(acts?.remove ? [
      { label: trailCount > 0 ? W.removeMarker : appConfig.copy.remove, danger: trailCount === 0, onClick: () => acts.remove?.() },
      ...(trailCount > 0 && acts.clearTrail ? [{ label: W.clearTrail, danger: true, onClick: () => acts.clearTrail?.() }] : []),
      ...(trailCount > 0 && acts.removeWithTrail ? [{ label: W.removeMarkerTrail, danger: true, onClick: () => acts.removeWithTrail?.() }] : []),
    ].map((r) => ({ ...r, label: <>{lead('trash')}<span>{r.label}</span></> })) : []),
  ]
  const outTrupp = raus ? trupps.find((t) => t.id === truppId) : undefined
  /** The pill, in its two places. ON THE SURFACE it is the marker's own picture – the one that is
   *  renamed in place, and the one the dock is found from; while the card is docked it is
   *  the ringed name alone (and the storey: where it is). IN THE CARD it says everything. */
  const pillOf = (onSurface: boolean) => {
    const whole = !onSurface || !docked
    return (
      // ⚠️ the pill span carries the native class untouched: putting it on the hit shell made
      // the button the flex container, and Safari's anonymous button box misplaced the cap.
      <span ref={onSurface ? pillRef : undefined} data-docked={onSurface && docked ? '' : undefined}
        className={`wb-resource-pill ${raus ? 'raus' : ''}${line ? ' joined' : ''}${tone === 'warn' || tone === 'crit' ? ` tone-${tone}` : ''}`}
        style={{ '--team': color, ...(line ? { '--line': line.color } : null) } as CSSProperties}>
        {/* The coupling, in the hose's ink, at the pill's LEFT edge — the same edge the marker is
            anchored by, so the stub sits exactly where the line ends. Absolutely positioned: it
            must not push the cap (and with it the coordinate the pill states) sideways. */}
        <span className="wb-resource-cap" />
        <span className="wb-resource-body">
          <span className="wb-resource-name">
            {onSurface && renaming && rename
              ? <span className="wb-resource-edit">
                  <input className="wb-resource-input" autoFocus={!renameRef} ref={renameRef} value={draft}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onChange={(ev) => setDraft(ev.target.value)}
                    onBlur={(ev) => { rename(ev.target.value); setRenaming(false) }}
                    enterKeyHint="done"
                    // Return commits, Esc KEEPS what was typed – both leave the field, whose blur
                    // renames (owner, 17.11.2026 – lib/fieldKeys; Esc used to abandon the edit)
                    onKeyDown={(ev) => { if (leaveOnEnter(ev)) ev.stopPropagation() }} />
                  {/* ✕ empties the field WITHOUT committing or closing — `preventDefault` on the
                      press keeps the focus (and the phone keyboard) on the field the operator is
                      about to type the new name into, exactly as ClearableInput does it. */}
                  {draft !== '' && (
                    <button type="button" className="wb-resource-clear"
                      title={appConfig.copy.atemschutz.clearName} aria-label={appConfig.copy.atemschutz.clearName}
                      onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation() }}
                      onClick={() => setDraft('')}
                    ><Icon id="close" /></button>
                  )}
                </span>
              : <b>{name}</b>}
            {/* no «#N» badge here either (14.09.) — on the picture the name alone is the label, the
                number lives on the Atemschutz card (docs/trupp-naming.md §2) */}
            {/* the board's word for it (truppCardText · truppStateWord): a work squad is «Ohne
                Auftrag», not the PA-out «Draussen» (ENT.7); a marker on no Trupp keeps the plain word */}
            {whole && raus && <span className="wb-resource-raus">{outTrupp ? truppStateWord(outTrupp) : appConfig.copy.atemschutz.status.raus}</span>}
            {/* the storey, LAST: the cap is the coordinate this marker states, and everything in
                front of it moves the point (see the cap comment above). Same chip chrome as the
                Leitung's number beside it, in the Trupp's own ink. */}
            {floor != null && <span className="team-floor" title={floorLabel(floor)}>{floorBadge(floor)}</span>}
          </span>
          {whole && time && <i className="wb-resource-time">{time}</i>}
        </span>
      </span>
    )
  }
  const pill = pillOf(true)
  const bar = acts && (
    <div className={`wb-pill-acts${worded ? ' worded' : ''}${docked ? ' docked' : ''}`}
      onPointerDown={(ev) => ev.stopPropagation()}>
      {zumTrupp ? (
        // the Trupps nav glyph (NavRail · stopwatch): a door to that page, never a warning ⚠
        <button className="wb-pa wb-pa-show" title={W.showTrupp} aria-label={W.showTrupp}
          onClick={() => showTrupp?.(zumTrupp)}><Icon id="stopwatch" />{barWord(W.showTrupp)}</button>
      ) : join && <TruppJoinMenu {...join} word={barWord(W.joinShort)} />}
      {/* the bar's short word for «Position markieren», whose full words stay title + label */}
      {mark && (
        <button className="wb-pa" title={W.markPosition} aria-label={W.markPosition}
          onClick={mark}><Icon id="flag" />{barWord(W.markShort)}</button>
      )}
      {/* «Lösen» while the marker hangs on something – the glyph every bond cut wears; ↶ takes it back */}
      {release && (
        <button className="wb-pa" title={releaseWord} aria-label={releaseWord}
          onClick={release}><Icon id="unlink" />{barWord(releaseWord)}</button>
      )}
      {moreRows.length > 0 && (
        <Menu
          popupClassName="de-menu-pop"
          itemClassName={() => 'de-menu-item'}
          onOpenChange={(open) => { if (open) setMorePage('rows') }}
          trigger={
            <button className="wb-pa wb-pa-more" title={W.barMore} aria-label={W.barMore}>
              <Icon id="more" />{barWord(W.barMore)}
            </button>
          }
          items={morePage === 'join' && join ? truppJoinItems(join) : moreRows}
        />
      )}
    </div>
  )
  return (
    <>
      {hit ? hit(pill) : pill}
      {dockHost ? createPortal(
        // ⚠️ React bubbles a portal's events up its COMPONENT tree – into the marker's press
        // (select / hold-drag) and the Plan anno's double tap. The card stops them at its edge,
        // as the bar always has.
        <div className="wb-pill-dock">
          <div className="wb-pill-card" onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
            {pillOf(false)}
            {onClose && (
              <button type="button" className="wb-pill-card-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog}
                onClick={onClose}><Icon id="close" /></button>
            )}
          </div>
          {bar}
        </div>,
        dockHost,
      ) : bar}
    </>
  )
}
