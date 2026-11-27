import { ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// What the Verwaltung shows for a request that failed: the server's German message, the
// instruction that came with it (`ApiError.hint`, but never the field app's line on a dead link –
// see describeApiError), and for a 422 the refused fields by their German name — never FastAPI's
// English Pydantic sentence, which is what `ApiError.detail` holds for a validation answer
// (lib/api · ApiError.fields). Every admin view's save, delete, upload
// and import path reads its error through `describeApiError` / `apiErrorText`; each view still
// decides where and how the line is shown.


/** Config-document path → the field's own name and the Station page that edits it. Resolved
 *  at call time (never at module level), so a locale switch applies. Only the paths Verwaltung
 *  can actually write are listed; anything else falls back to the dotted path, which still
 *  answers «which field» — unlike an English Pydantic sentence. */
export function rejectedFieldLabel(path: string): string {
  const A = appConfig.copy.admin
  const P = A.nav
  const known: Record<string, { field: string; page: string }> = {
    'identity.appName': { field: A.identity.appName, page: P.identitaet.title },
    'identity.shortName': { field: A.identity.shortName, page: P.identitaet.title },
    'identity.accentColor': { field: A.identity.accentColor, page: P.identitaet.title },
    'identity.locale': { field: A.identity.language, page: P.identitaet.title },
    'identity.kommandant': { field: A.identity.kommandant, page: P.identitaet.title },
    'map.defaultView.zoom': { field: A.map.zoom, page: P.karte.title },
    // the pair AND the block: a bad coordinate reports on `…center`, the "one CRS only" rule
    // on `…defaultView` itself
    'map.defaultView.center': { field: A.map.centerField, page: P.karte.title },
    'map.defaultView': { field: A.map.centerField, page: P.karte.title },
    'journal.quickPhrases': { field: A.journal.quickPhrases, page: P.journal.title },
    'report.hoursRounding': { field: A.report.groupRounding, page: P.rapport.title },
    'report.attendanceMergeGapMin': { field: A.report.mergeGapMin, page: P.rapport.title },
    'report.partnerOrgs': { field: A.report.groupPartners, page: P.rapport.title },
    'report.links': { field: A.report.groupLinks, page: P.rapport.title },
    'fleet.vehicles': { field: A.fleet.groupVehicles, page: P.fahrzeuge.title },
    'alarms.groups': { field: A.alarms.groupGroups, page: P.alarme.title },
    'alarms.webhooks': { field: A.alarms.groupWebhooks, page: P.alarme.title },
    'doctrine': { field: P.doktrin.title, page: P.doktrin.title },
    // No Station page edits these — the Mittel-Katalog is exactly what Sicherung → Import
    // exists for, which makes them the paths MOST likely to be refused and the ones that had
    // no German name at all. Listed with no page, so they read as a plain name.
    'mittel.catalogue': { field: A.backup.fieldMittelCatalogue, page: A.backup.fieldMittelCatalogue },
    'mittel.sources': { field: A.backup.fieldMittelSources, page: A.backup.fieldMittelSources },
    'mittel.units': { field: A.backup.fieldMittelUnits, page: A.backup.fieldMittelUnits },
    // …and the whole SECTIONS, as the last resort before a raw path. A config import is refused
    // (and a config import EMPTIES things) one whole section at a time far more often than one
    // field, and «fleet» is not a word anybody at this station chose.
    'identity': { field: P.identitaet.title, page: P.identitaet.title },
    'map': { field: P.karte.title, page: P.karte.title },
    'fleet': { field: P.fahrzeuge.title, page: P.fahrzeuge.title },
    'roster': { field: P.mannschaft.title, page: P.mannschaft.title },
    'report': { field: P.rapport.title, page: P.rapport.title },
    'journal': { field: P.journal.title, page: P.journal.title },
    // ⚠️ «Alarme & Einsätze», NOT «Alarmierung»: the `alarms` SECTION of the config document is
    // edited on the Station page of that name (Alarmgruppen, the archive clocks, the capture
    // window, the webhooks). `nav.divera` is the Divera intake status page and edits none of it —
    // naming it here sent a reader with a refused import to a page with nothing to fix on it.
    'alarms': { field: P.alarme.title, page: P.alarme.title },
    'referenceLayers': { field: P.ebenen.title, page: P.ebenen.title },
    'modules': { field: P.objektplaene.title, page: P.objektplaene.title },
    'mittel': { field: appConfig.copy.mittel.title, page: appConfig.copy.mittel.title },
  }
  // Longest matching prefix wins, so a row path (`report.links.0.title`) resolves to the
  // editor that owns the row instead of falling through to the raw path.
  const segs = path.split('.')
  for (let n = segs.length; n > 0; n--) {
    const hit = known[segs.slice(0, n).join('.')]
    if (hit) return hit.field === hit.page ? hit.field : `${hit.field} (${hit.page})`
  }
  return path
}

/** Pydantic's error `type` as the one thing a hand-edited file needs to know: what shape was
 *  expected there. Anything unlisted contributes nothing rather than a guess — the field name,
 *  the position and the value that WAS found already carry the answer on their own. */
function expectedShape(kind: string | undefined): string | null {
  const C = appConfig.copy.admin.backup
  if (!kind) return null
  if (kind === 'missing') return C.expectMissing
  if (kind === 'extra_forbidden') return C.expectUnknown
  if (kind.startsWith('string')) return C.expectText
  if (kind.startsWith('list') || kind.startsWith('tuple') || kind.startsWith('set')) return C.expectList
  if (kind.startsWith('dict') || kind.startsWith('model')) return C.expectObject
  if (kind.startsWith('int')) return C.expectInteger
  if (kind.startsWith('float') || kind.startsWith('decimal')) return C.expectNumber
  if (kind.startsWith('bool')) return C.expectBool
  return null
}

/** The value the server actually found there, short enough to read in one line. */
function foundValue(input: unknown): string | null {
  if (input === undefined) return null
  let text: string
  try { text = typeof input === 'string' ? `«${input}»` : JSON.stringify(input) ?? String(input) }
  catch { return null }
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/**
 * A 422 from the config endpoint, one readable German line per refused field.
 *
 * ⚠️ The server already says exactly what is wrong — `loc: ["body","mittel","sources",0]`,
 * `input: "TLF 31"` — and «Konfiguration ungültig (422) – Datei passt nicht zum Schema» threw
 * all of it away. A volunteer importing a Mittel-Katalog (the documented route to the one thing
 * the UI cannot edit) then has nothing to go on but guessing, and guessed three times before
 * finding that `units` are strings and `sources` are objects.
 *
 * So each line names WHICH field, WHICH entry of it, what was expected and what was found —
 * and never the raw Pydantic sentence, which is English.
 */
export function describeRejectedFields(e: ApiError): string[] {
  const C = appConfig.copy.admin.backup
  const lines = (e.fields ?? []).map(({ path, kind, input }) => {
    const segs = path.split('.')
    const isIndex = (s: string) => /^\d+$/.test(s)
    // The LAST index in the path — `report.links.2.title` is «entry 3 of Formulare», and a
    // deeper nesting still points at the row the operator has to find. 1-based, because the
    // file is read by a person: `sources.0` is the FIRST entry.
    const indexes = segs.filter(isIndex)
    const index: string | undefined = indexes[indexes.length - 1]
    const name = rejectedFieldLabel(segs.filter((s) => !isIndex(s)).join('.'))
    const where = index != null ? `${name}, ${fillTemplate(C.invalidEntry, { n: Number(index) + 1 })}` : name
    const what = [expectedShape(kind), foundValue(input) && fillTemplate(C.invalidFound, { value: foundValue(input)! })]
      .filter(Boolean).join(' · ')
    return what ? `${where}: ${what}` : where
  })
  return [...new Set(lines)]
}

/** A failed admin request, as the operator reads it. */
export interface AdminError {
  message: string
  /** what to do about it, where the refusal said (lib/api · ApiError.hint) – never the field
   *  app's line on a dead link (`ApiError.transportHint`) */
  hint?: string
  /** the refused fields by name — set only for a 422 that named its fields */
  fields?: string[]
}

/**
 * Turn a failed request into what the admin shows. A 422 that names its fields reads
 * «Vom Server nicht angenommen: <Feld> · <Feld>»; any other `ApiError` keeps the server's own
 * (German) message and its hint. A failure of the link itself (no network, no answer, a proxy's
 * 502–504) keeps its reason – «Server nicht erreichbar», «Keine Antwort» – and drops the hint:
 * «Gespeicherte Einsätze bleiben offline verfügbar» is the field app's promise and means nothing
 * on an admin page. `fallback` is the view's own sentence for everything that is no
 * `ApiError` (a bug, a parse error) and for a 422 that names no field; without one it is
 * «Unbekannter Fehler» (`common2.unknownError`). `labels` names the fields of a request body that
 * is not the config document (`display_name` → «Name»), by the words its form uses.
 */
export function describeApiError(
  e: unknown,
  fallback: string = appConfig.copy.admin.common2.unknownError,
  labels?: Readonly<Record<string, string>>,
): AdminError {
  if (!(e instanceof ApiError)) return { message: fallback }
  if (e.fields?.length) {
    // a model-level refusal (`loc: ["body"]`) names no field — the fallback says more than «: »
    const fields = [...new Set(e.fields.map((f) => labels?.[f.path] ?? rejectedFieldLabel(f.path)).filter(Boolean))]
    if (!fields.length) return { message: fallback }
    return { message: fillTemplate(appConfig.copy.admin.autosave.rejected, { fields: fields.join(' · ') }), fields }
  }
  return { message: e.detail, hint: e.transportHint ? undefined : e.hint }
}

/** `describeApiError` as one line («message hint»), for the views that show a single text. */
export function apiErrorText(e: unknown, fallback?: string, labels?: Readonly<Record<string, string>>): string {
  const { message, hint } = describeApiError(e, fallback, labels)
  return hint ? `${message} ${hint}` : message
}
