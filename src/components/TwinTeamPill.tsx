/** The selected Truppmarker's pill + context bar — the ONE copy, for all four places it shows.
 *
 *  Twin doctrine: a projection carries the same capabilities through the same functions its
 *  original has — rename, Trupp-Join, Farbe, «Position markieren», the Spuren-Auge, the locked
 *  trash — plus the one door a projection alone needs, «zum Original». That bar used to be
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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { leaveOnEnter } from '../lib/fieldKeys'
import { Menu } from '../lib/overlays'
import { MenuPick } from './MenuPick'
import { appConfig } from '../config/appConfig'
import { floorBadge } from '../lib/symbolRender'
import { floorLabel } from '../lib/whiteboard'
import type { LineTone, TeamLineBadge } from '../lib/truppLines'
import { truppStateWord } from './truppCardText'
import { useRailLabels } from '../lib/useDevicePrefs'
import { useIsPhone } from '../lib/useIsPhone'
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
export function TruppJoinMenu({ truppId, trupps, pick, create, onNone, word }: {
  truppId?: string; trupps: Trupp[]; pick: (truppId?: string) => void; create?: () => void
  /** the bar's word under the glyph (TwinTeamPill · `barWord`) – absent with «Beschriftung» off */
  word?: ReactNode
  /** «Kein Trupp» exists only on a marker that hangs on a hose (15.09., Bastian): it takes the
   *  marker off the Leitung – hose unlinked and uncoupled, marker a step away, still this Trupp's.
   *  A marker on nothing has no such entry; leaving the picture is the trash can. */
  onNone?: () => void
}) {
  return (
    <Menu
      popupClassName="de-menu-pop"
      itemClassName={() => 'de-menu-item'}
      trigger={
        // the Trupps page's own glyph, the stopwatch: 👥 is the Anwesenheit's door one rail away
        // (duck sweep ELEM.12 – one glyph, one meaning, within a thumb's reach)
        <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
          <Icon id="stopwatch" />{word}
        </button>
      }
      items={[
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
      ]}
    />
  )
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
   *  then there is no trash at all. */
  remove?: () => void
  /** «Marker und Spur löschen» — both at once, and NO ghost is left standing: the surface arms
   *  the reconciliation's `dropped` set before it removes, so the ghost is born already stamped
   *  (lib/truppTrails). Absent ⇒ the row is not offered, like every other writer here. */
  removeWithTrail?: () => void
  showTrupp?: (truppId: string) => void
  /** pan the OTHER surface to the original — the MIRROR's one extra door, absent on a native */
  toOriginal?: () => void
  toggleTrail?: () => void
  /** «Lösen» on a joined marker (Karte, 15.09.): let go of the Leitung this Trupp is on. Offered
   *  only where a `line` badge is also drawn — a surface that does not show the join does not
   *  offer to break it. */
  unlink?: () => void
  /** let go of the symbol the marker is docked to (lib/docking) – the same «Lösen» glyph */
  undock?: () => void
}

/** How much of the stage an edge-hugging bar must keep to itself. */
const EDGE_MARGIN = 8
/** The gap the bar keeps from the marker — the same number `.wb-pill-acts` states in CSS. */
const BAR_GAP = 9
/** The lanes a phone pins over the bottom of the stage (pill row, tool rail, tool dock). They are
 *  `position: fixed` only where they actually cover the surface, and none of them exists on the
 *  Karte — so this is a query, never a table of per-surface offsets. */
const BOTTOM_LANES = '.wb-botleft, .wb-tools, .wb-dock'

/**
 * Keep the action bar on screen. It hangs BELOW the marker, and a marker low on the stage put it
 * under the phone's fixed bottom lanes — or straight past the canvas' own `overflow: hidden`
 * edge, where it was simply cut off. So the bar MEASURES where it landed: not enough room below
 * (and more above) flips it above the marker, and it slides sideways until both canvas edges are
 * clear by EDGE_MARGIN. `data-flip="up"` is the one signal, so the connections panel that hangs
 * under the bar on the Plan follows it through a CSS sibling selector rather than a second
 * measurement. The anchor is the bar's own offset parent — `.wb-anno` on the Plan, `.marker` on
 * the Karte — so both surfaces get this from the same code.
 */
function useBarPlacement(on: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState({ up: false, dx: 0 })
  /** the placement last handed to React — what `measure` compares against */
  const placed = useRef(place)
  /**
   * ⚠️ `measure` sets state ONLY when the placement really changed (24.09.2026). It runs after
   * every render, and it used to call `setPlace` every time — with an updater that returned the
   * old value, which React still has to schedule and render to find out. Harmless alone; inside
   * the live-GPS render storm of 23.09.2026 it was the update that tipped React's nested-update
   * counter, so #185 was thrown HERE, in the tapped Trupp's pill, and took the Karte down.
   * Compared against a ref, an unchanged measurement is no update at all.
   */
  const measure = useCallback(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const stage = el.closest('.wb-canvas')?.getBoundingClientRect()
    const ceil = Math.max(stage?.top ?? 0, 0)
    let floor = Math.min(stage?.bottom ?? window.innerHeight, window.innerHeight)
    for (const lane of Array.from(document.querySelectorAll(BOTTOM_LANES))) {
      const r = lane.getBoundingClientRect()
      if (r.height > 0 && getComputedStyle(lane).position === 'fixed') floor = Math.min(floor, r.top)
    }
    const a = anchor.getBoundingClientRect()
    const bar = el.getBoundingClientRect()
    // whatever hangs under the bar counts towards the room the bar needs — it moves with it
    const panel = anchor.querySelector('.wb-resource-connections')?.getBoundingClientRect()
    const need = BAR_GAP + bar.height + (panel?.height ? panel.height + 4 : 0) + EDGE_MARGIN
    const below = floor - a.bottom
    const up = below < need && a.top - ceil > below
    // ⚠️ The nudge is computed ABSOLUTELY — from where the bar would sit UNshifted — never as a
    // correction to the shift already applied. Reading its own effect back makes the pass depend
    // on the browser having laid the last one out, and one environment that does not (jsdom
    // measures every rect as zero) walks the bar off the screen one pass per render.
    const minX = (stage?.left ?? 0) + EDGE_MARGIN
    const maxX = (stage?.right ?? window.innerWidth) - EDGE_MARGIN
    // …and sideways by the WIDER of the bar and the panel under it (11.10.2026): the Plan's
    // «Verbundene Linien» card is wider than the bar, and on a phone it hung off the screen edge
    // while the bar beside it had been nudged clear. Both take the one nudge (`--acts-dx`).
    const w = Math.max(bar.width, panel?.width ?? 0)
    const home = a.left + a.width / 2 - w / 2
    let dx = 0
    if (home + w > maxX) dx = maxX - w - home
    if (home + dx < minX) dx = minX - home
    dx = Math.round(dx)
    anchor.style.setProperty('--acts-dx', `${dx}px`)
    // the bar's own height, for the connections panel that hangs under it (09-whiteboard): a
    // worded bar is taller, and on a narrow phone it may wrap to two rows
    if (bar.height > 0) anchor.style.setProperty('--acts-h', `${Math.round(bar.height)}px`)
    if (placed.current.up === up && placed.current.dx === dx) return
    placed.current = { up, dx }
    setPlace(placed.current)
  }, [])
  // no dep array on purpose: every render re-measures, which is what a dragged or re-labelled
  // marker needs — and costs nothing when nothing moved (see `measure`)
  useLayoutEffect(() => { if (on) measure() })
  // …while the listeners are bound once per opening, not re-bound on every render
  useLayoutEffect(() => {
    if (!on) return
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [on, measure])
  return [ref, place] as const
}

export function TwinTeamPill({ name, time, color, originalLabel, raus, truppId, floor, tone = 'idle', trailCount, trailShown, trupps, line, acts, hit, renameRef, renaming: renamingProp, onRenaming }: {
  name: string
  time?: string
  /** the colour actually painted (the source's own, or the palette's first) */
  color: string
  /** «Auf Plan zeigen» / «Auf Karte zeigen» — which surface the original lives on. Mirrors
   *  only: on a native surface the marker IS the original, so there is nowhere to send you. */
  originalLabel?: string
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
   *  mirrors: pen only) and the pill keeps the flag, since leaving the pill IS the commit. */
  renaming?: boolean
  onRenaming?: (on: boolean) => void
}) {
  // inline rename on the pill's pen — the same grammar every surface uses
  const [selfRenaming, setSelfRenaming] = useState(false)
  const [barRef, barPlace] = useBarPlacement(!!acts)
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
  const toOriginal = acts?.toOriginal
  const toggleTrail = acts?.toggleTrail
  const unlink = acts?.unlink
  const undock = acts?.undock
  /* ── Words on the bar (rare-user round M10, owner pick A + note, 17.11.2026) ── with «Beschriftung»
     on (the rails' setting, the default) every button wears its word under the glyph, as the worded
     dock tiles do, and the three rare doors – «Position markieren», «Spuren», the original – fold
     into a worded «Mehr» whose rows carry glyph + full word: the bar keeps at most four worded
     buttons (Lösen or the pen · Zum Trupp · Atemschutz-Trupp · Entfernen) plus «Mehr», on every
     surface and device. Off, the bar is the flat glyph row it always was. The `aria-label`s stay.
     On a PHONE the five worded buttons are wider than the screen and «Entfernen» wrapped onto a row
     of its own, so there the delete rows join «Mehr» as its last rows and the bar stays one row. */
  const worded = useRailLabels() === 'short'
  const isPhone = useIsPhone()
  const removeInMore = worded && isPhone
  const barWord = (w: string) => worded ? <span className="wb-pa-word">{w}</span> : null
  const W = appConfig.copy.whiteboard
  const rare: { key: string; icon: string; label: string; onClick: () => void; cls?: string; pressed?: boolean }[] = [
    ...(mark ? [{ key: 'mark', icon: 'flag', label: W.markPosition, onClick: mark, cls: ' wb-pa-mark' }] : []),
    // per-team visibility toggle, NOT deletion — the ✕ here silently wiped the record. Pressed =
    // the rename pen's `--sel` fill (or the menu's ✓), its name the CONTROL («Spuren»), never the
    // next action (duck sweep ELEM.5: it flipped its title and swapped eye / eye-off, no fill)
    ...(trailCount > 0 && toggleTrail ? [{ key: 'trails', icon: 'eye', label: W.trails, onClick: toggleTrail, pressed: trailShown }] : []),
    ...(toOriginal && originalLabel ? [{ key: 'orig', icon: 'external', label: originalLabel, onClick: toOriginal }] : []),
  ]
  // the delete rows: the marker alone, and – where it carries a Spur – the trail alone or both
  // (see «ONE trash» below). The bar's trash menu and the phone's «Mehr» show the same rows.
  const removeRows = acts?.remove ? [
    { label: trailCount > 0 ? W.removeMarker : appConfig.copy.remove, danger: trailCount === 0, onClick: () => acts.remove?.() },
    ...(trailCount > 0 && acts.clearTrail ? [{ label: W.clearTrail, danger: true, onClick: () => acts.clearTrail?.() }] : []),
    ...(trailCount > 0 && acts.removeWithTrail ? [{ label: W.removeMarkerTrail, danger: true, onClick: () => acts.removeWithTrail?.() }] : []),
  ] : []
  const outTrupp = raus ? trupps.find((t) => t.id === truppId) : undefined
  // ⚠️ the pill span carries the native class untouched: putting it on the hit shell made
  // the button the flex container, and Safari's anonymous button box misplaced the cap.
  const pill = (
    <span className={`wb-resource-pill ${raus ? 'raus' : ''}${line ? ' joined' : ''}${tone === 'warn' || tone === 'crit' ? ` tone-${tone}` : ''}`}
      style={{ '--team': color, ...(line ? { '--line': line.color } : null) } as CSSProperties}>
      {/* The coupling, in the hose's ink, at the pill's LEFT edge — the same edge the marker is
          anchored by, so the stub sits exactly where the line ends. Absolutely positioned: it
          must not push the cap (and with it the coordinate the pill states) sideways. */}
      <span className="wb-resource-cap" />
      <span className="wb-resource-body">
        <span className="wb-resource-name">
          {renaming && rename
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
          {raus && <span className="wb-resource-raus">{outTrupp ? truppStateWord(outTrupp) : appConfig.copy.atemschutz.status.raus}</span>}
          {/* the storey, LAST: the cap is the coordinate this marker states, and everything in
              front of it moves the point (see the cap comment above). Same chip chrome as the
              Leitung's number beside it, in the Trupp's own ink. */}
          {floor != null && <span className="team-floor" title={floorLabel(floor)}>{floorBadge(floor)}</span>}
        </span>
        {time && <i className="wb-resource-time">{time}</i>}
      </span>
    </span>
  )
  return (
    <>
      {hit ? hit(pill) : pill}
      {acts && (
        <div ref={barRef} className={`wb-pill-acts${worded ? ' worded' : ''}`} data-flip={barPlace.up ? 'up' : undefined}
          style={{ transform: `translateX(calc(-50% + ${barPlace.dx}px))` }}
          onPointerDown={(ev) => ev.stopPropagation()}>
          {/* «Lösen» (15.09.): the one explicit way to part the marker from what it hangs on – its
              Leitung, the symbol it is docked to, or both at once. First in the bar: the hose's own
              end tag says which Leitung, and the words «Leitung 1 · Trupp 3» said nothing the
              picture did not. */}
          {((line && unlink && truppId) || undock) && (
            <button className="wb-pa wb-pa-unlink" title={appConfig.copy.contextPanel.dockedRelease} aria-label={appConfig.copy.contextPanel.dockedRelease}
              onClick={() => { if (line && truppId) unlink?.(); undock?.() }}><Icon id="unlink" />{barWord(appConfig.copy.contextPanel.dockedRelease)}</button>
          )}
          {/* rename — the touch path (double-tap→dblclick is unreliable on iOS). A Trupp-bound
              marker is named by the Atemschutz board, so it gets no pen: renaming it here would
              fork the two names apart. */}
          {!truppId && rename && (
            // lit while the field is open — the docks' pressed toggle (`--sel`), so the pen says
            // which mode the pill is in; every other action on the bar is neutral (K3, 29.09.2026)
            // ⚠️ `preventDefault` on the press, like the ✕ beside the field: without it the pen
            // could never CLOSE the edit — pressing it blurred the input first (commit +
            // `setRenaming(false)`), so the click that followed found `renaming` already false
            // and opened the field straight back up.
            <button className={`wb-pa${renaming ? ' wb-pa-edit' : ''}`} aria-pressed={renaming}
              title={appConfig.copy.edit} aria-label={appConfig.copy.edit}
              onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation() }}
              onClick={() => setRenaming(!renaming)}><Icon id="pen" />{barWord(appConfig.copy.edit)}</button>
          )}
          {truppId && showTrupp && (
            // the Trupps nav glyph (NavRail · stopwatch): this is a door to that page, not a
            // warning — the ⚠ said «warning» on a Trupp that had none (K3, 29.09.2026)
            <button className="wb-pa wb-pa-show" title={W.showTrupp} aria-label={W.showTrupp}
              onClick={() => showTrupp(truppId)}><Icon id="stopwatch" />{barWord(W.showTrupp)}</button>
          )}
          {/* «Atemschutz-Trupp» — the join sheet (TruppJoinMenu above), whenever this surface
              offers the door at all */}
          {pick && <TruppJoinMenu truppId={truppId} trupps={trupps} pick={pick} create={newTrupp}
            onNone={line && unlink && truppId ? unlink : undefined} word={barWord(appConfig.copy.atemschutz.markerLabel)} />}
          {/* the rare doors: flat glyphs with «Beschriftung» off, rows of «Mehr» with it on */}
          {worded ? ((rare.length > 0 || (removeInMore && removeRows.length > 0)) && (
            <Menu
              popupClassName="de-menu-pop"
              itemClassName={() => 'de-menu-item'}
              trigger={
                <button className="wb-pa wb-pa-more" title={W.barMore} aria-label={W.barMore}>
                  <Icon id="more" />{barWord(W.barMore)}
                </button>
              }
              items={[
                ...rare.map((a) => ({
                  label: <>
                    <span className="de-menu-lead" aria-hidden><Icon id={a.icon} /></span>
                    {a.pressed === undefined ? <span>{a.label}</span> : <MenuPick label={a.label} on={a.pressed} />}
                  </>,
                  onClick: a.onClick,
                })),
                ...(removeInMore ? removeRows.map((r) => ({
                  label: <><span className="de-menu-lead" aria-hidden><Icon id="trash" /></span><span>{r.label}</span></>,
                  danger: r.danger, onClick: r.onClick,
                })) : []),
              ]}
            />
          )) : rare.map((a) => (
            <button key={a.key} className={`wb-pa${a.cls ?? ''}${a.pressed ? ' wb-pa-edit' : ''}`} title={a.label} aria-label={a.label}
              aria-pressed={a.pressed} onClick={() => a.onClick()}><Icon id={a.icon} /></button>
          ))}
          {/* ONE trash (18.09.2026). The bar carried two red-ish doors for a while — the trash and
              a separate «Spur löschen» wearing the building-outline glyph — and the footprint did
              not read as a delete at all. So the trash is the one delete on this bar, and where
              the marker carries a Spur it ASKS which of the two goes (the app's own Menu, never a
              native select): the marker alone (its trail stays behind as a ghost the incident
              owns, lib/truppTrails), the trail alone, or both. The two trail rows are danger rows
              and each confirms before anything is destroyed; a marker with no trail has nothing to
              ask about and the trash removes it straight away, exactly as before. Always last. */}
          {acts.remove && !removeInMore && (trailCount > 0 ? (
            <Menu
              popupClassName="de-menu-pop"
              itemClassName={() => 'de-menu-item'}
              trigger={
                <button className="wb-pa wb-pa-del" title={appConfig.copy.remove} aria-label={appConfig.copy.remove}>
                  <Icon id="trash" />{barWord(appConfig.copy.remove)}
                </button>
              }
              items={removeRows}
            />
          ) : (
            <button className="wb-pa wb-pa-del" title={appConfig.copy.remove} aria-label={appConfig.copy.remove}
              onClick={() => acts.remove?.()}><Icon id="trash" />{barWord(appConfig.copy.remove)}</button>
          ))}
        </div>
      )}
    </>
  )
}
