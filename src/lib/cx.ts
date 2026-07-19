// Tiny className join helper for CSS Modules: drops falsy entries and joins with
// a space. Lets conditional/dynamic classes read cleanly, e.g.
//   cx(s.row, sel && s.sel)  →  "row_a1b2 sel_c3d4"  (or just "row_a1b2")
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
