import { appConfig } from '../config/appConfig'

/**
 * «Formulare & Links» — the station's own paperwork, on the Rapport.
 *
 * Every Wehr has forms that live outside this app and still have to be filled in after an
 * Einsatz: a Getränke-Abrechnung for the Gemeinde, a Schadenmeldung for the Versicherung, an
 * internal Google-Form. They are station-specific by nature, so they are CONFIGURATION
 * (`report.links`), not a feature: a deployment that configures none has no such section on
 * its Rapport at all.
 *
 * The URL may carry `{platzhalter}` tokens, which resolve from the Einsatz at the moment the
 * link is opened (see `resolveLinkUrl`). That is what turns «hier ist der Link» into «hier ist
 * das Formular, Anlass und Datum stehen schon drin» — the 3am difference between a form that
 * gets filled in and one that does not. Google Forms takes them as `?usp=pp_url&entry.<id>=…`;
 * anything else that prefills from the query string works the same way.
 */
export interface ReportLink {
  /** stable id — the tick state on an Einsatz is filed under it (ReportMeta · linksDone) */
  id: string
  title: string
  /** absolute http(s) URL, may contain `{platzhalter}` tokens */
  url: string
  /** when this has to be filled in («nur bei Gebäudeschaden, innert 48 h») */
  note?: string | null
}

/** The placeholders a station may put in a link URL. Offered as chips in Verwaltung › Rapport,
 *  so nobody has to remember them. Every one of them can legitimately be EMPTY (a rapport is
 *  written while the Einsatz runs), and an empty one resolves to an empty string rather than
 *  leaving `{…}` standing in a form field. */
export const REPORT_LINK_TOKENS = [
  'stichwort', 'ort', 'datum', 'alarmzeit', 'einsatzende',
  'einsatzleiter', 'kontaktperson', 'kurzbericht', 'wehr',
] as const
export type ReportLinkToken = (typeof REPORT_LINK_TOKENS)[number]

/** What the tokens are read off — the Einsatz plus the Rapportangaben as they stand right now. */
export interface ReportLinkFacts {
  stichwort?: string | null
  ort?: string | null
  /** ISO — the Alarmierung, which is also the day the Einsatz is filed under */
  alarmiertAt?: string | null
  endedAt?: string | null
  einsatzleiter?: string | null
  kontaktperson?: string | null
  kurzbericht?: string | null
  /** the Wehr's own name (deploymentConfig · deploymentName) */
  wehr?: string | null
}

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(appConfig.locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(appConfig.locale, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Resolve every token to the string it stands for. `{datum}` is a plain date and the two
 * instants carry their date with them — a multi-day Einsatz would otherwise put «07:20» on a
 * form with no way to tell which morning it was.
 */
export function linkTokenValues(f: ReportLinkFacts): Record<ReportLinkToken, string> {
  return {
    stichwort: f.stichwort?.trim() ?? '',
    ort: f.ort?.trim() ?? '',
    datum: dateOnly(f.alarmiertAt),
    alarmzeit: dateTime(f.alarmiertAt),
    einsatzende: dateTime(f.endedAt),
    einsatzleiter: f.einsatzleiter?.trim() ?? '',
    kontaktperson: f.kontaktperson?.trim() ?? '',
    kurzbericht: f.kurzbericht?.trim() ?? '',
    wehr: f.wehr?.trim() ?? '',
  }
}

/**
 * Substitute `{token}` with its URL-encoded value.
 *
 * ⚠️ An UNKNOWN token is left standing verbatim. A typo (`{einsatzort}`) then shows up in the
 * preview in Verwaltung and in the opened form as `{einsatzort}` — findable. Silently dropping
 * it would leave a blank field that looks exactly like a field the app has nothing to say
 * about, which is the one failure nobody would ever chase down.
 */
export function resolveLinkUrl(url: string, values: Record<string, string>): string {
  return url.replace(/\{([a-z]+)\}/g, (whole, token: string) =>
    (token in values ? encodeURIComponent(values[token]) : whole))
}

/**
 * Is this a link we are willing to open? http(s) only — the URLs come from the config
 * document, and `javascript:` in an href is a script the station never asked for. Anything
 * else is dropped at the boundary (see deploymentConfig · reportLinks) rather than rendered
 * as a dead row.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
