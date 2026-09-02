// Helpers for the inline SVG markup the app builds by hand — the map's vehicle and person
// glyphs (useVehiclePositions / usePersonPositions) and the Gefahrgut placard (placard.ts).
// Those glyphs are assembled as strings and handed to MapLibre as data URIs, so every value
// that comes from a person — a vehicle name, somebody's initials, a UN substance name — has to
// be escaped on the way in or one apostrophe-free «Kran & Bergung» silently paints nothing.

/**
 * Escape a string for use in SVG/XML, as element text OR inside a double-quoted attribute.
 *
 * `"` is escaped as well as `&<>` precisely because these callers put names into attributes;
 * the printed rapport's own escaper (lib/report · escapeXml) deliberately does NOT, because
 * its output goes into ReportLab's mini-HTML as element content and that document is signed.
 */
export const xmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
