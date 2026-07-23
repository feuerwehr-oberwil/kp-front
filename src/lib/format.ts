import { appConfig } from '../config/appConfig'

const prefixPattern = new RegExp(`^(${appConfig.symbols.namePrefixes.join('|')})\\s+`, 'i')

// FireGIS symbol keys are ASCII-transliterated (ae/oe/ue) and a few drop the
// umlaut entirely (Ture). Restore proper umlauts for display only — the raw name
// stays the lookup key into the symbol library. de-CH keeps "ss" (no ß), and we
// only touch genuinely-transliterated words so "Feuer"/"Wasser" are left alone.
const UMLAUTS: [RegExp, string][] = [
  [/loesch/g, 'lösch'], [/Loesch/g, 'Lösch'],
  [/geraet/g, 'gerät'], [/Geraet/g, 'Gerät'],
  [/stueck/g, 'stück'], [/Stueck/g, 'Stück'],
  [/schluessel/g, 'schlüssel'], [/Schluessel/g, 'Schlüssel'],
  [/Sanitaet/g, 'Sanität'],
  [/Gefaehrlich/g, 'Gefährlich'],
  [/Luefter/g, 'Lüfter'],
  [/moeglich/g, 'möglich'],
  [/Rueck/g, 'Rück'],
  [/Ueber/g, 'Über'], [/ueber/g, 'über'],
  [/\bTure\b/g, 'Türe'],
]

export function restoreUmlauts(s: string): string {
  return UMLAUTS.reduce((acc, [re, rep]) => acc.replace(re, rep), s)
}

// Avatar initials from a display name, umlaut-folded so "Führungsunterstützung" → "FU"
// (not "FÜ"). Single word → its first two letters; multiple → first + last initial.
function foldUmlauts(s: string): string {
  return s
    .replace(/[ÄäÀ-Åà-å]/g, (c) => (c === c.toUpperCase() ? 'A' : 'a'))
    .replace(/[Ööò-ö]/g, (c) => (c === c.toUpperCase() ? 'O' : 'o'))
    .replace(/[Üüù-ü]/g, (c) => (c === c.toUpperCase() ? 'U' : 'u'))
    .replace(/ß/g, 'SS')
}
export function initials(name: string): string {
  const parts = foldUmlauts(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Display label for a backend role (editor/viewer). Display-only; the wire value
// stays 'editor'/'viewer'.
export function roleLabel(role: string): string {
  return role === 'editor' ? 'Bearbeiter' : 'Betrachter'
}

export function formatSymbolName(name: string): string {
  // localized display label wins, then the per-deployment displayNames override (keeps de output
  // identical + custom overrides working), then strip prefix/numbers and restore umlauts
  const key = name.trim()
  const localized = appConfig.copy.symbolNames[key]
  if (localized) return localized
  const override = appConfig.symbols.displayNames[key]
  if (override) return override
  const base = key.replace(prefixPattern, '').replace(/^\d+\s+\d+\s+/, '').trim()
  return restoreUmlauts(base)
}

/** elapsed duration as h:mm (Einsatzuhr) — hours uncapped so a 26-h incident reads 26:05 */
export function fmtElapsedHM(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

/** Zero-pad a number to two digits: 7 → "07". */
export const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local wall-clock HH:MM (24h, always zero-padded) from a Date — the hand-inlined
 *  `${pad(h)}:${pad(m)}` spelled once. Locale-independent by design, unlike formatTime. */
export function hhmm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatTime(date: Date, withSeconds = false): string {
  return date.toLocaleTimeString(appConfig.locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
  })
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
}
