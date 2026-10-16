import { useContext } from 'react'
import { sanitizeSvg } from '../../lib/sanitizeSvg'
import { Icon } from '../../lib/icons'
import { KeyBoxSvg } from '../../lib/karte/keyBox'

/** A key box's glyph in lists and the panel head: the pack's FKS «Schlüsseldepot» (lib/karte/keyBox). */
export function KeyBoxGlyph() {
  const svg = useContext(KeyBoxSvg)
  // the pack has not loaded (or failed for good): the plain object glyph stands in
  if (!svg) return <Icon id="station" />
  // ⚠️ SEC-01 — sanitise AT THE SINK, like every symbol SVG (components/Palette)
  return <span className="fks" aria-hidden dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
}
