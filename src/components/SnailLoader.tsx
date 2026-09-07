/**
 * The boot/loading mascot: the «Heavy haul» snail — leans forward, strains against the weight,
 * then gives the shell one satisfying tug (3.6 s loop). Replaces the old .ping pulse (07.09.).
 *
 * Self-contained on purpose: the animation rides in the SVG's own <style>, so the SAME markup
 * is inlined in index.html's static boot splash and renders with zero external resources —
 * keep the two copies in sync (a pointing comment sits at both). Selectors are scoped under
 * .snail-loader because an inline SVG's <style> joins the document cascade. The shell reads
 * the station accent (per-station theming; the sample's red as fallback), the reduced-motion
 * block stills every part, and aria-hidden keeps it decoration — the card's text is the status.
 */
export function SnailLoader() {
  return (
    <svg className="snail-loader" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 168 120" aria-hidden="true">
      <style>{`
        .snail-loader { width: 120px; height: auto; --sn-stalk: #231f20; }
        /* Night contrast (field report 07.09.): the eye stalks are the one part drawn as bare
           dark strokes against the BACKGROUND — on the night ground they vanished and the eyes
           floated. They take the body's cream at night; every other dark line sits on a light
           or red fill and keeps its ink. The faint warm rim lifts the dark edge-linework off
           the dark ground without changing the artwork. */
        :root[data-theme="night"] .snail-loader { --sn-stalk: #fff0cf; filter: drop-shadow(0 0 5px rgba(255, 240, 207, .09)); }
        .snail-loader .sn-actor { transform-origin: 80px 100px; animation: sn-travel 3.6s cubic-bezier(.45,0,.3,1) infinite; }
        .snail-loader .sn-foot { transform-origin: 65px 100px; animation: sn-foot 3.6s ease-in-out infinite; }
        .snail-loader .sn-neck { transform-origin: 100px 96px; animation: sn-reach 3.6s cubic-bezier(.45,0,.3,1) infinite; }
        .snail-loader .sn-house { transform-origin: 65px 65px; animation: sn-house 3.6s cubic-bezier(.45,0,.3,1) infinite; }
        .snail-loader .sn-eye-back { transform-origin: 111px 58px; animation: sn-back 3.6s ease-in-out infinite; }
        .snail-loader .sn-eye-front { transform-origin: 120px 57px; animation: sn-front 3.6s ease-in-out infinite; }
        @keyframes sn-travel { 0%,45%,100% {transform:translateX(-5px)} 68%,78% {transform:translateX(5px)} }
        @keyframes sn-foot { 0%,100% {transform:scaleX(1)} 30%,49% {transform:scaleX(1.14)} 66% {transform:scaleX(.94)} 82% {transform:scaleX(1)} }
        @keyframes sn-reach { 0%,100% {transform:translate(0,0) rotate(0deg)} 24% {transform:translate(10px,0) rotate(13deg)} 37% {transform:translate(12px,2px) rotate(18deg)} 45% {transform:translate(10px,2px) rotate(15deg)} 51% {transform:translate(12px,1px) rotate(18deg)} 65% {transform:translate(7px,-2px) rotate(-3deg)} 78% {transform:translate(3px,0) rotate(2deg)} }
        @keyframes sn-house { 0%,100% {transform:translate(0,0) rotate(0deg)} 28%,44% {transform:translate(-7px,1px) rotate(-13deg)} 51% {transform:translate(-6px,0) rotate(-16deg)} 64% {transform:translate(11px,-6px) rotate(18deg)} 73% {transform:translate(7px,1px) rotate(7deg)} 82% {transform:translate(4px,0) rotate(4deg)} }
        @keyframes sn-back { 0%,100% {transform:rotate(0deg)} 23% {transform:rotate(-21deg)} 38%,49% {transform:rotate(18deg)} 63% {transform:rotate(0deg)} 77% {transform:rotate(7deg)} }
        @keyframes sn-front { 0%,100% {transform:rotate(0deg)} 18% {transform:rotate(21deg)} 37%,48% {transform:rotate(11deg)} 63% {transform:rotate(-29deg)} 79% {transform:rotate(10deg)} }
        @media (prefers-reduced-motion: reduce) { .snail-loader * { animation: none !important; } }
      `}</style>
      <g className="sn-actor">
        <g className="sn-foot"><path d="M23 93 Q41 81 70 87 Q94 82 117 89 Q132 96 143 98 Q147 104 138 105 H31 Q17 105 12 101 Q16 95 23 93Z" fill="#fff0cf" stroke="#231f20" strokeWidth="4" strokeLinejoin="round" /></g>
        <g className="sn-neck">
          <path d="M91 94 Q104 83 102 66 Q101 51 113 50 Q127 49 127 65 Q126 80 119 94 Q112 102 98 100Z" fill="#fff0cf" stroke="#231f20" strokeWidth="4" />
          <g>
            <g className="sn-eye-back"><path d="M111 58 Q109 44 102 36" fill="none" stroke="var(--sn-stalk, #231f20)" strokeWidth="4" strokeLinecap="round" /><circle cx="102" cy="34" r="6.5" fill="#fff" stroke="#231f20" strokeWidth="3" /><circle cx="104" cy="34" r="2.5" fill="#231f20" /></g>
            <g className="sn-eye-front"><path d="M120 57 Q121 40 125 30" fill="none" stroke="var(--sn-stalk, #231f20)" strokeWidth="4" strokeLinecap="round" /><circle cx="126" cy="28" r="7" fill="#fff" stroke="#231f20" strokeWidth="3" /><circle cx="128" cy="28" r="2.8" fill="#231f20" /></g>
          </g>
          <path d="M116 71 Q122 76 126 70" fill="none" stroke="#231f20" strokeWidth="2.7" strokeLinecap="round" />
          <circle cx="111" cy="69" r="3" fill="#f2a900" />
        </g>
        <g className="sn-house">
          <circle cx="65" cy="65" r="32" fill="var(--accent, #ee3523)" stroke="#231f20" strokeWidth="4.5" />
          <path d="M47 82 C27 63 43 38 65 42 C90 45 92 78 72 83 C54 89 43 68 53 57 C63 47 78 58 73 68 C69 77 58 72 62 65" fill="none" stroke="#231f20" strokeWidth="4.5" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  )
}
