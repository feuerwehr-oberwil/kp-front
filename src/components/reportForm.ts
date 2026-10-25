// The Rapportangaben as the Rapport holds them on screen, and the two ways back to the blob:
// everything as it stands (`formToMeta`, for reading) and only what this device changed
// (`dirtyFormMeta`, for writing). Pure; used by ReportPreflight, whose fields merge with the other
// devices through useSyncedField. Rules: docs/rapport.md.

import { deriveAusgerueckt } from '../lib/alarmzeiten'
import { closeTimeOf, type IncidentMeta } from '../lib/incidents'
import { dtLocalToIso, dtLocalValue } from '../lib/format'
import { einsatzleiterFromScene } from '../lib/report'
import type { FahrzeugZeit, GruppeZeit, PartnerContact, ReportMeta } from '../lib/workspace'
import type { Entity } from '../types'

/** Does this partner row say anything at all? Blank rows live on screen and never reach the blob. */
export const partnerFilled = (p: PartnerContact) => [p.org, p.name, p.phone, p.note].some((v) => v?.trim())

/** A typed count as the blob stores it — «», «3 », «-1» and «abc» all mean «nichts eingetragen». */
export const numOrU = (s: string): number | undefined => {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

/** The synced Rapportangaben, each in the shape its control holds it (a dtLocal string, «» for
 *  absent, a list). The partner list is synced too but kept apart: it never reaches `meta`. */
export type ReportForm = {
  summary: string
  kontaktperson: string
  kontaktTel: string
  einsatzleiter: string
  endedAt: string
  ausgerueckt: string
  remarks: string
  lehren: string
  gruppen: GruppeZeit[]
  fahrzeuge: FahrzeugZeit[]
  geretteteP: string
  geretteteT: string
  rueckName: string
  /** ⚠️ The full ISO, not an HH:MM — the Rückmeldung is regularly given after midnight */
  rueckAt: string
}

/** What the BLOB says, field by field, in the shape each field holds it in on screen. Read on
 *  every render; `useSyncedField` decides per field whether the screen follows it. */
export function remoteForm(reportMeta: ReportMeta, sceneEntities: Entity[] | undefined, incident: IncidentMeta): ReportForm {
  return {
    summary: reportMeta.summary ?? '',
    kontaktperson: reportMeta.kontaktperson ?? '',
    kontaktTel: reportMeta.kontaktpersonTelefon ?? '',
    // ⚠️ The Kroki fallback belongs in here, not beside it: it is what an EMPTY blob shows, so a
    // field sitting on the seeded name is in agreement with the blob and must not count as an
    // edit this device has to defend (ReportPreflight · seededEinsatzleiter persists it, once).
    einsatzleiter: reportMeta.einsatzleiter ?? einsatzleiterFromScene(sceneEntities) ?? '',
    endedAt: dtLocalValue(reportMeta.endedAt ?? closeTimeOf(incident) ?? undefined),
    ausgerueckt: dtLocalValue(reportMeta.ausgeruecktAt),
    remarks: reportMeta.remarks ?? '',
    lehren: reportMeta.lehren ?? '',
    gruppen: reportMeta.gruppen ?? [],
    fahrzeuge: reportMeta.fahrzeuge ?? [],
    geretteteP: reportMeta.gerettete?.personen?.toString() ?? '',
    geretteteT: reportMeta.gerettete?.tiere?.toString() ?? '',
    rueckName: reportMeta.rueckmeldungElz?.name ?? '',
    rueckAt: reportMeta.rueckmeldungElz?.at ?? '',
  }
}

/** The two Gerettete counts as their ONE blob key. */
export const geretteteMeta = (p: string, t: string): Partial<ReportMeta> => ({
  gerettete: numOrU(p) !== undefined || numOrU(t) !== undefined
    ? { personen: numOrU(p), tiere: numOrU(t) } : undefined,
})

/** The Rückmeldung's name + time as their ONE blob key. The time is a full ISO, not a clock:
 *  the Rückmeldung is often given LATER than it happened — «ah, die ELZ hab ich gestern um 23:40
 *  informiert» — and a bare clock filed a call made the next morning on the night of the fire. */
export const rueckMeta = (name: string, iso: string): Partial<ReportMeta> => {
  const at = iso || undefined
  return { rueckmeldungElz: name.trim() || at ? { name: name.trim() || undefined, at } : undefined }
}

/** The partner list as the blob keeps it: the filled rows, or nothing. */
export const partnersMeta = (partners: PartnerContact[]): Partial<ReportMeta> => {
  const clean = partners.filter(partnerFilled)
  return { partnerContacts: clean.length ? clean : undefined }
}

/**
 * The form AS IT STANDS ON SCREEN, for everything that reads the rapport rather than writes it:
 * the head's «noch offen», the Abschluss-Checkliste, the printed draft. An Einsatzende typed a
 * second ago has to count here without a round trip.
 *
 * The header «Ausgerückt» is DERIVED (first physical departure) once any per-vehicle time
 * exists; the manual field stays authoritative only while there is no vehicle data.
 */
export function formToMeta(f: ReportForm): Partial<ReportMeta> {
  return {
    summary: f.summary.trim() || undefined,
    kontaktperson: f.kontaktperson.trim() || undefined,
    kontaktpersonTelefon: f.kontaktTel.trim() || undefined,
    einsatzleiter: f.einsatzleiter.trim() || undefined,
    endedAt: dtLocalToIso(f.endedAt),
    ausgeruecktAt: deriveAusgerueckt(f.fahrzeuge) ?? dtLocalToIso(f.ausgerueckt),
    remarks: f.remarks.trim() || undefined,
    lehren: f.lehren.trim() || undefined,
    gruppen: f.gruppen.length ? f.gruppen : undefined,
    fahrzeuge: f.fahrzeuge.length ? f.fahrzeuge : undefined,
    ...geretteteMeta(f.geretteteP, f.geretteteT),
    ...rueckMeta(f.rueckName, f.rueckAt),
  }
}

/** Which form fields each blob key is written from. Most are one; three keys are two fields —
 *  the header «Ausgerückt» follows the vehicle grid the moment it holds anything. */
const SOURCES: [keyof ReportMeta, (keyof ReportForm)[]][] = [
  ['summary', ['summary']],
  ['kontaktperson', ['kontaktperson']],
  ['kontaktpersonTelefon', ['kontaktTel']],
  ['einsatzleiter', ['einsatzleiter']],
  ['endedAt', ['endedAt']],
  ['ausgeruecktAt', ['ausgerueckt', 'fahrzeuge']],
  ['remarks', ['remarks']],
  ['lehren', ['lehren']],
  ['gruppen', ['gruppen']],
  ['fahrzeuge', ['fahrzeuge']],
  ['gerettete', ['geretteteP', 'geretteteT']],
  ['rueckmeldungElz', ['rueckName', 'rueckAt']],
]

/**
 * What THIS device is entitled to write: the blob keys whose fields its operator actually
 * changed and whose change has not landed in the blob yet (`dirty`, see useSyncedField).
 * Everything else is left to pass through from the latest blob.
 *
 * ⚠️ This used to be all fifteen fields, every time, out of state seeded at mount — so a device
 * with the Rapport open wrote its own half-hour-old idea of every field back on the next
 * keystroke, and the Kurzbericht the Einsatzleiter had just typed on the iPad was gone.
 * ⚠️ Where two fields share ONE blob key, an untouched half is taken from the blob, not from
 * this device's copy of it: writing `gerettete` because the Tiere moved must not put back the
 * Personen count another device corrected in the meantime.
 */
export function dirtyFormMeta(local: ReportForm, remote: ReportForm, dirty: Record<keyof ReportForm, boolean>): Partial<ReportMeta> {
  const touched = SOURCES.filter(([, fields]) => fields.some((f) => dirty[f]))
  if (!touched.length) return {}
  const mixed = Object.fromEntries(
    (Object.keys(local) as (keyof ReportForm)[]).map((f) => [f, dirty[f] ? local[f] : remote[f]]),
  ) as ReportForm
  const all = formToMeta(mixed)
  return Object.fromEntries(touched.map(([key]) => [key, all[key]])) as Partial<ReportMeta>
}
