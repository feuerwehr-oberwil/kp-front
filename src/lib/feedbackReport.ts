// Builds the feedback text the operator sends. Nothing here talks to the network.
//
// The whole design constraint: a deployment is a fire station that owns its data, and this app's
// promise is «eure Feuerwehr, eure Daten». An app that POSTs feedback upstream breaks that the
// first time someone opens the network tab — so we compose the report locally, SHOW the operator
// exactly what it contains, and let them send it. Less volume, but nothing to explain away.
//
// The technical block is therefore deliberately thin: build, locale, device, viewport, online
// state, and which trouble kind triggered the prompt. No incident id, no address, no roster name,
// no coordinates, no screenshot. If a field would help us debug but could identify an Einsatz or
// a person, it does not belong here — the operator can always describe it in their own words.

import { appConfig } from '../config/appConfig'
import type { TroubleKind } from './trouble'

export interface ReportEnv {
  /** buildLabel() — "v0.2.0 · a1b2c3d · 25.07.2026" */
  build: string
  /** active UI locale, e.g. "de-CH" */
  locale: string
  /** navigator.userAgent — device/browser, the single most useful line for a rendering bug */
  userAgent: string
  /** "1024×768" */
  viewport: string
  /** navigator.onLine at the moment of writing */
  online: boolean
}

export interface ReportInput {
  env: ReportEnv
  /** what the operator typed; may be empty (they can send just the technical block) */
  message: string
  /** the trouble that triggered the prompt, if any (absent when opened from Einstellungen) */
  trouble?: { kind: TroubleKind; at: number }
  /** formats `trouble.at` for humans; injected so this stays pure and testable */
  fmtTime?: (at: number) => string
}

/**
 * Fields that must never reach the report, asserted by the tests so a later edit can't quietly
 * widen the payload. Documentation and guard rail in one — if you are here to add a field,
 * the question is not "is it useful" but "could it identify an Einsatz or a person".
 */
export const NEVER_INCLUDED = [
  'incidentId', 'address', 'lat', 'lng', 'personnel', 'screenshot', 'workspace',
] as const

/** Human-readable label for a trouble kind, for both the report and the prompt headline.
 *  Reads copy at call time (never at module level) so the active locale wins — see CLAUDE.md. */
export function troubleLabel(kind: TroubleKind): string {
  return appConfig.copy.feedback.kinds[kind]
}

/** The technical block, shown verbatim to the operator before they send anything. */
export function buildTechBlock(input: ReportInput): string {
  const { env, trouble, fmtTime } = input
  const t = appConfig.copy.feedback.tech
  const lines = [
    `${t.version} ${env.build}`,
    `${t.locale} ${env.locale}`,
    `${t.device} ${env.userAgent}`,
    `${t.viewport} ${env.viewport}`,
    `${t.network} ${env.online ? t.online : t.offline}`,
  ]
  if (trouble) {
    const when = fmtTime ? fmtTime(trouble.at) : new Date(trouble.at).toISOString()
    lines.push(`${t.event} ${troubleLabel(trouble.kind)} (${when})`)
  }
  return lines.join('\n')
}

/** The full report: the operator's words first — that is the part a human reads — then the
 *  technical block, separated by the usual signature marker. */
export function buildReport(input: ReportInput): string {
  const msg = input.message.trim()
  return `${msg || appConfig.copy.feedback.tech.noDescription}\n\n--\n${buildTechBlock(input)}\n`
}

/** Subject line: the trouble kind makes triage possible at a glance. */
export function buildSubject(input: ReportInput, appName: string): string {
  const s = appConfig.copy.feedback.subject
  return input.trouble ? `${appName}: ${s} (${troubleLabel(input.trouble.kind)})` : `${appName}: ${s}`
}

/** `mailto:` URL for the report. Kept pure so the encoding is testable — a raw newline or an
 *  unencoded `&` in the body silently truncates the mail in some clients. */
export function mailtoUrl(address: string, subject: string, body: string): string {
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** Snapshot the environment. The only impure function in this module; kept separate so
 *  everything above can be tested without a DOM. */
export function readEnv(build: string, locale: string): ReportEnv {
  const w = typeof window === 'undefined' ? undefined : window
  return {
    build,
    locale,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    viewport: w ? `${w.innerWidth}×${w.innerHeight}` : '',
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  }
}
