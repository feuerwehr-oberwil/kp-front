import { useEffect, useState } from 'react'
import { getIncidentMeta } from './incidents'
import { parseAlarmText } from './alarmText'

// The Alarmmeldung of an Einsatz, to READ – the «Einsatzdaten prüfen» band and the Einsatz menu
// show it (owner pick UX journeys B3·4, 25.11.2026: «Eine Person wird vermisst» was readable only
// inside the edit form). The text is not part of the list's IncidentMeta, so it is fetched with
// the Einsatz (without its workspace). What is shown is what a person wrote: the gateway's
// machinery (Ausrückeordnung, Einsatzplan, our own link) is parsed off as the Rapport's
// «Alarmmeldung» does (lib/alarmText) – the words themselves are never touched, never searched
// for keywords, never highlighted.

/** last answer per Einsatz, so the menu opens on the text the band already fetched */
const known = new Map<string, string>()

/** The human-written Alarmmeldung of Einsatz `id` – `''` when the alarm carried none, `null`
 *  while it is not known (loading, offline on a first read). Re-read on every mount and whenever
 *  the Einsatz's `updatedAt` moves (a correction in the Einsatzdaten). */
export function useAlarmMessage(id: string, updatedAt?: string): string | null {
  // the answer of this hook's last read, kept with its id: another Einsatz's answer is no answer
  const [read, setRead] = useState<{ id: string; msg: string } | null>(null)
  useEffect(() => {
    let alive = true
    getIncidentMeta(id)
      .then((full) => {
        const msg = parseAlarmText(full.text).message
        known.set(id, msg)
        if (alive) setRead({ id, msg })
      })
      // offline or refused: keep what is known – the band and the menu simply show no text
      .catch(() => {})
    return () => { alive = false }
  }, [id, updatedAt])
  return read?.id === id ? read.msg : known.get(id) ?? null
}
