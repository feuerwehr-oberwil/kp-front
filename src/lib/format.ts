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

/** Zero-pad a number to two digits: 7 → "07". */
export const pad2 = (n: number) => String(n).padStart(2, '0')

/** elapsed duration as h:mm (Einsatzuhr) — hours uncapped so a 26-h incident reads 26:05 */
export function fmtElapsedHM(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(mins / 60)}:${pad2(mins % 60)}`
}

/** MM:SS with BOTH halves padded — a running recorder's readout, where a jumping width under
 *  the thumb is what the padding buys («09:07», never «9:07»). Minutes are uncapped. */
export function fmtMMSS(totalSec: number): string {
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`
}

/**
 * An audio clip's length: «12:34», and «2:15:03» once it passes the hour. Leading minutes are
 * NOT padded — this is a duration read as a number, not a clock (see `fmtMMSS` for that one).
 *
 * `compact` is the LABEL form, used where the duration annotates something else (an imported
 * Sprachmemo in a list): under a minute it says «47s» rather than «0:47», and it rounds to the
 * nearest second instead of truncating, because a label is written once from a finished file.
 * The player's live readout does neither — a counter that rounds up would show the end of a
 * clip a second before it arrives.
 */
export function fmtDuration(sec: number, { compact = false } = {}): string {
  const s = Math.max(0, compact ? Math.round(sec) : Math.floor(sec))
  if (compact && s < 60) return `${s}s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`
}

/** How long a stretch lasts, for a card head: «29 min» under the hour, else «4 h 00». Hours are
 *  uncapped — a three-day availability reads «58 h 07», not «10 h 07». This is the number the
 *  operator worked out in their head before deciding who to send home. */
export function fmtSpanShort(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h ${pad2(mins % 60)}`
}

/** A due time that fell to the next day (an exact Uhrzeit earlier than now rolls forward). */
export function isNextDay(iso: string): boolean {
  const due = new Date(iso)
  const today = new Date()
  return due.getDate() !== today.getDate() || due.getMonth() !== today.getMonth()
}

/** «06:30» or «06:30 · morgen» — a Wiedervorlage's due time, with the day when it is not today.
 *  The composer said «morgen» while the banner and the journal row showed the bare clock, so a
 *  reminder set for 06:30 tomorrow read as one that was already 14 hours overdue. */
export function dueClock(iso: string): string {
  const t = formatTime(new Date(iso))
  return isNextDay(iso) ? `${t}${appConfig.copy.journal.reminderTomorrow}` : t
}

/** Local wall-clock HH:MM (24h, always zero-padded) from a Date — the hand-inlined
 *  `${pad(h)}:${pad(m)}` spelled once. Locale-independent by design, unlike formatTime. */
export function hhmm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** ISO ⇄ <input type="datetime-local"> string (local time, minute precision). */
export function dtLocalValue(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
export function dtLocalToIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
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

/**
 * Strip what the printed Einsatzrapport cannot set — emoji, pictographs, dingbats and the
 * joiners/variation selectors that glue them together.
 *
 * The rapport is composed server-side in Helvetica (backend · report_pdf), which has no glyph
 * for any of these: a «Brand 🔥 im 2. OG» typed on a phone came out as «Brand ■ im 2. OG» on the
 * sheet that gets signed — and only there, so nobody saw it until the paper was in their hand.
 * Blocked at the input instead of fixed at render, so what the app shows and what the printer
 * prints are the same string (decision 2026-08-08).
 *
 * ⚠️ Text that does NOT come through a field of ours — the Alarmmeldung as the ELZ sent it —
 * is untouched by this and can still print a box.
 *
 * Umlauts, accents, «·», en dashes and the rest of Latin-1 are left alone: Helvetica sets them.
 */
export function stripUnprintable(s: string): string {
  return s
    // Pictographs proper: emoji, dingbats, arrows-as-symbols, geometric shapes, and the
    // private-use area an icon font would sit in.
    // ⚠️ …EXCEPT «→» and «←» (U+2192 / U+2190), which the journal writes on purpose: «EL → Sanität»
    // is the shape of nearly every line in a Funkprotokoll, and the composer offers the character
    // as a suggestion (JournalComposer · ARROW). They were caught by this range for a day and
    // vanished from the field the moment the next keystroke arrived. Helvetica still has no glyph
    // for them, so the PAPER gets «->» instead — mapped once, where the rapport payload is built
    // (lib/reportPdfDirect · forPaper), not by silently editing what the operator typed.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2191}\u{2193}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{E000}-\u{F8FF}]/gu, '')
    // …then the glue: variation selectors, the zero-width joiner and the keycap mark. Taking
    // the whole grapheme apart is exactly the intent here — «👨‍🚒» must leave nothing behind,
    // and a lone joiner after its pictograph is gone would be an invisible character in a
    // signed document. (eslint reads a class of combining marks as an accident; this isn't one.)
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    // a removed emoji between two words leaves «Brand  im 2. OG» — one space, not two
    .replace(/ {2,}/g, ' ')
}

/**
 * `tel:` URI for a phone number as typed — «079 123 45 67» dials as `tel:0791234567`, a leading
 * «+41» survives. The display keeps the operator's formatting; only the link normalizes.
 * Undefined when what remains is too short to be a number, so no call button appears on «-».
 */
export function telHref(raw?: string): string | undefined {
  const dial = (raw ?? '').replace(/[^\d+]/g, '')
  return dial.replace(/\D/g, '').length >= 3 ? `tel:${dial}` : undefined
}
