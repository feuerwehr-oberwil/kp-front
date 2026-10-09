import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { notfallFacts, truppLogName } from './atemschutz'
import type { Trupp } from '../types'

// The words of an Atemschutznotfall (F1, 08.10.2026) — pure, so the Tafel's banner, the
// Meldeleiste row and their tests agree by construction (components/AtemschutzNotfall).

/** «vor 4 min» — how old a reported value is, in the shortest honest unit. */
export function ageWords(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

/** «Trupp 2 (Meier Anna / Huber Beat)» — the crew as the radio and the Verlauf name it. */
export function notfallWho(t: Trupp): string {
  return fillTemplate(appConfig.copy.atemschutz.notfall.who, { name: truppLogName(t) })
}

/**
 * The facts of one Notfall as short phrases, in the order they are read out on the radio: since
 * when, where, how much air (and how old that number is), which channel. Pure, so the banner, the
 * Meldeleiste row and their tests agree by construction. `place` is the caller's
 * (useTruppActions · truppPlace).
 */
export function notfallFactLine(t: Trupp, now: number, place?: string): string[] {
  const nf = appConfig.copy.atemschutz.notfall
  const f = notfallFacts(t, now)
  const bar = f.bar > 0
    ? `${fillTemplate(nf.bar, { bar: f.bar })} · ${f.barAgeSec != null ? fillTemplate(nf.barAge, { age: ageWords(f.barAgeSec) }) : nf.barEntry}`
    : ''
  return [
    t.notfallAt ? fillTemplate(nf.since, { time: formatTime(new Date(t.notfallAt)) }) : '',
    place ?? '',
    bar,
    f.funkkanal != null ? fillTemplate(nf.kanal, { n: f.funkkanal }) : '',
  ].filter(Boolean)
}
