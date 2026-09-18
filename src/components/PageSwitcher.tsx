import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { RAPPORT_PAGES, type RapportPage } from '../lib/rapportPages'
import { Segmented } from './Segmented'

/**
 * PHONE ONLY — the Rapport group's page switcher, docked just above the navigation bar.
 *
 * The bar holds five tiles (18.09.2026), so Rapport, Anwesenheit and Material share one: the
 * «Rapport» tile is the DOOR to the three, and it opens whichever of them this device was last
 * on (lib/rapportPages). That leaves «and now switch to the other one», which without this
 * control costs a trip back down to the bar, a tap, and a second tap in whatever the tile opens.
 * During an Appell — mark somebody present, check the Rapport's Zeiten, back — that is the loop
 * the operator is in for ten minutes at a stretch.
 *
 * ⚠️ A switcher, NOT a set of tabs. Folding the other two INTO the Rapport as tabs of its own
 * strip was tried on 18.09. and thrown out the same day: the Rapport's head, its tab strip, the
 * embedded surface's head and THAT surface's own switcher made four rows of navigation stacked
 * down one 360px screen. The three stay ordinary separate full pages; this rides at the FOOT of
 * all three, in the thumb's reach, beside the bar it belongs to — it reads as an extension of
 * the bar, which is what it is, rather than as a second heading.
 *
 * ⚠️ The words are the rail's own (`copy.modes`), because these are the same three destinations
 * the vertical rail names with three tiles. One thing, one word, on every form factor.
 */
export function PageSwitcher({ mode, onMode, presentCount = 0, openCount = 0 }: {
  /** the page standing right now — one of the three */
  mode: RapportPage
  onMode: (m: RapportPage) => void
  /** how many people are marked present — the same number the bar's «Rapport» tile carries, said
   *  again HERE on the segment that leads to it, because from inside the group the tile is behind
   *  this control. 0 paints nothing. */
  presentCount?: number
  /** how many Mindestangaben of the Rapport are still open (lib/abschluss · missingSteps) — a
   *  DOT, not a figure: «noch offen» is a yes/no on this control, and the Rapport's own head
   *  names every one of them the moment you are there. Same amber as that head's chips. */
  openCount?: number
}) {
  const C = appConfig.copy.modes
  const nav = appConfig.copy.navRail
  const A = appConfig.copy.anwesenheit
  const word: Record<RapportPage, string> = { rapport: C.rapport, anwesenheit: C.anwesenheit, mittel: C.mittel }

  return (
    <div className="pgsw">
      <Segmented<RapportPage>
        ariaLabel={nav.pageGroup}
        value={mode}
        onChange={onMode}
        options={RAPPORT_PAGES.map((m) => {
          const count = m === 'anwesenheit' && presentCount > 0 ? presentCount : 0
          const open = m === 'rapport' && openCount > 0
          return {
            value: m,
            // ⚠️ the badge has to be SAID, not only painted — `title` is what Segmented hands to
            // the button, and a coloured circle tells a screen reader nothing
            title: count
              ? `${word[m]} · ${fillTemplate(A.summary, { present: count })}`
              : open ? `${word[m]} – ${appConfig.copy.preflight.headStillOpen}` : word[m],
            label: (
              <>
                {word[m]}
                {count > 0 && <span className="pgsw-count" aria-hidden>{count > 99 ? '99+' : count}</span>}
                {open && <span className="pgsw-dot" aria-hidden />}
              </>
            ),
          }
        })}
      />
    </div>
  )
}
