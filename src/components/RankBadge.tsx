import { rankAbbr, rankDisplay } from '../lib/rank'
import s from './RankBadge.module.css'

/**
 * The Dienstgrad chip in front of a name — ONE look wherever a person is listed: the Anwesenheit,
 * the Zeitplan and the Schichten grid, and every roster picker (ComboMenu · ComboRank). The
 * Zeitplan drew its own in mono capitals on grey, so the same Offizier read «Of» on one tab and
 * «OF» on the next (UI sweep 07.10.2026). The abbreviation keeps the station's own case: «AdF»,
 * «Grfhr» and «Wm» are spellings, and capitals would turn them into other words.
 *
 * Renders nothing when the station's rank list has no abbreviation for the key — an empty chip in
 * front of a name is worse than none; the full label (or the raw key) is in the title.
 */
export function RankBadge({ rank }: { rank?: string }) {
  const abbr = rankAbbr(rank)
  if (!rank || !abbr) return null
  return <span className={s.rank} title={rankDisplay(rank)}>{abbr}</span>
}
