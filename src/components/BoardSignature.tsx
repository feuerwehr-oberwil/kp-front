/**
 * The Signaturen printed in the FKS «Erste Führung» Abspracherapport (10.10.2026), drawn as the
 * poster draws them: thin blue line work in a 48 × 48 box. A template names one by key in a
 * fixed `symbol` column; an unknown key draws nothing (the Bezeichnung still says what it is).
 *
 * Keys: patientensammelstelle, sanitaetshilfsstelle, rettungsachse, standort-einsatzleitung,
 * sammelstelle-unverletzte, warteraum (the poster's six), wasserbezug, absperrung (station switches).
 *
 * ⚠️ The Rapport draws the SAME shapes with ReportLab (backend · report_pdf · _draw_signature) —
 * a new key goes into both, or the paper prints an empty Signatur box.
 */
function shape(key: string) {
  switch (key) {
    // a square in four — the Patientensammelstelle
    case 'patientensammelstelle':
      return <><rect x="12" y="8" width="24" height="32" /><path d="M24 8v32M12 24h24" /></>
    // …in six — the Sanitätshilfsstelle
    case 'sanitaetshilfsstelle':
      return <><rect x="12" y="8" width="24" height="32" /><path d="M24 8v32M12 18.7h24M12 29.3h24" /></>
    // – R – – R – → the Rettungsachse
    case 'rettungsachse':
      return <>
        <path d="M1 24h4M13 24h4M21 24h4M33 24h4" />
        <path d="M40 20.5l6 3.5-6 3.5z" className="sig-fill" />
        <text x="9" y="27.5" fontSize={10} textAnchor="middle" className="sig-text">R</text>
        <text x="29" y="27.5" fontSize={10} textAnchor="middle" className="sig-text">R</text>
      </>
    // the pole with its pennant lines and the ring at the foot — the Standort Einsatzleitung
    case 'standort-einsatzleitung':
      return <><path d="M20 4v30M20 4h9M20 10h7M20 16h9" /><circle cx="20" cy="39" r="5" /></>
    // a box in three — the Sammelstelle Unverletzte
    case 'sammelstelle-unverletzte':
      return <><rect x="12" y="8" width="24" height="32" /><path d="M12 18.7h24M12 29.3h24" /></>
    // W in a square — the Warteraum
    case 'warteraum':
      return <><rect x="12" y="12" width="24" height="24" /><text x="24" y="30.5" fontSize={16} textAnchor="middle" className="sig-text">W</text></>
    // a ring with its outlet — the Wasserbezug (not on the FKS poster; a station switch)
    case 'wasserbezug':
      return <><circle cx="24" cy="24" r="11" /><path d="M24 13v22M35 24h8" /></>
    // a line with crosses — the Absperrung (not on the FKS poster; a station switch)
    case 'absperrung':
      return <path d="M2 24h44M10 19l6 10M16 19l-6 10M32 19l6 10M38 19l-6 10" />
    default:
      return null
  }
}

export function BoardSignature({ name, className }: { name: string; className?: string }) {
  const s = shape(name)
  if (!s) return null
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter">
      {s}
    </svg>
  )
}
