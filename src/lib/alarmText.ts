/**
 * Take the alarm text apart into the things it is actually made of.
 *
 * What reaches kp-front as one «Alarmmeldung» field is assembled by the alerting gateway
 * (fwo-divera · src/api/sms.py) out of four unrelated things:
 *
 *     <what the Leitstelle wrote>          ← often nothing at all
 *     Ausrückeordnung: 1. TLF → 2. PIO     ← generated from the vehicle field
 *                                          ← blank line
 *     Einsatzplan Grenzweg 1 – BLT Tramdepot
 *     Sofortmassnahmen:
 *       1. …
 *     Bemerkungen:
 *       …
 *     Lage & Pläne: https://front.fwo.li/l/<300-char JWT>
 *
 * Rendered verbatim that is mostly noise: a marching order the Mittel panel already knows, an
 * object's notes that belong to the Einsatzobjekt, and a link this app minted itself — under a
 * heading that promises a MESSAGE. On a callout where the Leitstelle wrote nothing, the field
 * is entirely machinery and the one thing it claims to show is the one thing absent.
 *
 * A parser rather than a heuristic, deliberately: every label here is a literal in the
 * generator, and the dispatch text always comes first. Anything that does not match falls
 * through to `message` untouched — a station whose gateway composes differently keeps seeing
 * its full text rather than having it quietly eaten.
 */

const ORDER_PREFIX = 'Ausrückeordnung:'
const PLAN_PREFIX = 'Einsatzplan '
const MEASURES_LABEL = 'Sofortmassnahmen:'
const NOTES_LABEL = 'Bemerkungen:'
const LINK_PREFIX = 'Lage & Pläne:'

export interface AlarmPlan {
  /** «Grenzweg 1 – BLT Tramdepot», or with the gateway's «(38 m entfernt)» caveat kept */
  header: string
  measures: string[]
  notes: string[]
}

export interface ParsedAlarmText {
  /** What a human actually wrote. Empty on the many callouts that carry no message. */
  message: string
  /** «1. TLF → 2. PIO» — the label stripped, since the field it lands in supplies one. */
  vehicleOrder: string
  /** The matched Einsatzobjekt's block, when one was near enough to attach. */
  plan: AlarmPlan | null
  /** Our own Einsatz-Link. Parsed out so it can be dropped: 300 characters of JWT is not
   *  something to print, and the app it points at is the one displaying it. */
  link: string
  /** True when nothing here was written by a person — the field is pure machinery. */
  machineOnly: boolean
}

const EMPTY: ParsedAlarmText = { message: '', vehicleOrder: '', plan: null, link: '', machineOnly: true }

export function parseAlarmText(raw: string | null | undefined): ParsedAlarmText {
  if (!raw || !raw.trim()) return EMPTY
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  let link = ''
  let sawLinkLabel = false
  let vehicleOrder = ''
  const head: string[] = []
  const planLines: string[] = []
  let inPlan = false

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith(LINK_PREFIX)) {
      // The gateway puts the URL on the same line — but a transport that wraps long lines
      // leaves the label alone and the URL on the next one, so remember that we saw it.
      link = t.slice(LINK_PREFIX.length).trim()
      sawLinkLabel = true
      inPlan = false
      continue
    }
    // …that next line, when it came to that.
    if (sawLinkLabel && !link && /^https?:\/\/\S+$/.test(t)) { link = t; continue }
    if (!link && !inPlan && t.startsWith(PLAN_PREFIX)) { inPlan = true; planLines.push(line); continue }
    if (inPlan) { planLines.push(line); continue }
    if (!vehicleOrder && t.startsWith(ORDER_PREFIX)) { vehicleOrder = t.slice(ORDER_PREFIX.length).trim(); continue }
    head.push(line)
  }

  return {
    message: head.join('\n').trim(),
    vehicleOrder,
    plan: parsePlan(planLines),
    link,
    machineOnly: head.join('').trim() === '',
  }
}

function parsePlan(lines: string[]): AlarmPlan | null {
  if (!lines.length) return null
  const header = lines[0].trim().slice(PLAN_PREFIX.length).trim()
  const measures: string[] = []
  const notes: string[] = []
  let bucket: 'none' | 'measures' | 'notes' = 'none'
  for (const line of lines.slice(1)) {
    const t = line.trim()
    if (!t) continue
    if (t === MEASURES_LABEL) { bucket = 'measures'; continue }
    if (t === NOTES_LABEL) { bucket = 'notes'; continue }
    // the generator numbers Sofortmassnahmen «  1. …»; the number is presentation, not content
    if (bucket === 'measures') measures.push(t.replace(/^\d+\.\s*/, ''))
    else if (bucket === 'notes') notes.push(t)
  }
  return { header, measures, notes }
}
