// A symbol whose FIRST shape is a filled, coloured plate (the VKF discs, AED, BMA-Z, RWA, the
// grey Rauch cloud) brings its own backdrop; black on it reads on any sheet.
const OWN_PLATE = /^<svg[^>]*>\s*<(?:circle|path|rect)\b[^>]*\bfill="#(?!000000|ffffff)[0-9a-fA-F]{6}"/i

/** Black drawn straight onto the background (Lift, Schieber, Nordpfeil …): it vanishes on a dark
 *  sheet, so the Karte tiles it (symbolRender · needsWhite) and at night the palette and the panel
 *  header give it the same white tile (`.glyph-tile`, 27.10.2026). */
export const bareBlack = (svg: string) => svg.includes('#000000') && !OWN_PLATE.test(svg)
