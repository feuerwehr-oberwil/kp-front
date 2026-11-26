import { useEffect, useState } from 'react'
import { getIncidentMeta } from './incidents'
import { parseAlarmText } from './alarmText'

// The Alarmmeldung of an Einsatz, to READ – the «Einsatzdaten prüfen» band and the Einsatz menu
// show it (owner pick UX journeys B3·4, 25.11.2026: «Eine Person wird vermisst» was readable only
// inside the edit form). The text is not part of the list's IncidentMeta, so it is fetched with
// the Einsatz (without its workspace). What is shown is what a person wrote: the gateway's
// machinery (Ausrückeordnung, Einsatzplan, our own link) is parsed off as the Rapport's
// «Alarmmeldung» does (lib/alarmText) – the words themselves are never touched, never searched
// for keywords, never highlighted. One thing only changes: a space between two digits becomes a
// no-break space, so a number reads whole (owner, sign-off 25.11.2026: the iPad broke «079 12…»
// off the rest of the caller's phone number).

/** last answer per Einsatz, so the menu opens on the text the band already fetched */
const known = new Map<string, string>()
/** ticket of the newest read started per Einsatz: reads are not ordered, only the newest may write `known` */
const newest = new Map<string, number>()
let tickets = 0

/** The human-written Alarmmeldung of Einsatz `id` – `''` when the alarm carried none, `null`
 *  while it is not known (loading, offline on a first read). Re-read on every mount and whenever
 *  the Einsatz's `updatedAt` moves (a correction in the Einsatzdaten). */
export function useAlarmMessage(id: string, updatedAt?: string): string | null {
  // the answer of this hook's last read, kept with its id: another Einsatz's answer is no answer
  const [read, setRead] = useState<{ id: string; msg: string } | null>(null)
  useEffect(() => {
    let alive = true
    const ticket = ++tickets
    newest.set(id, ticket)
    getIncidentMeta(id)
      .then((full) => {
        const msg = parseAlarmText(full.text).message.replace(/(\d) (?=\d)/g, '$1\u00a0')
        if (newest.get(id) === ticket) known.set(id, msg)
        if (alive) setRead({ id, msg })
      })
      // offline or refused: keep what is known – the band and the menu simply show no text
      .catch(() => {})
    return () => { alive = false }
  }, [id, updatedAt])
  return read?.id === id ? read.msg : known.get(id) ?? null
}
