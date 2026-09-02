import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'

// Published while the tactical symbol pack could not be loaded (lib/useSymbols · error). Karte
// and Kroki are mounted anyway with an empty glyph table — a symbol renders as its empty chip —
// so the row says what still works and offers the one thing that helps. Dismissible: a Karte
// without glyphs is a degraded Karte, not a danger.
export function SymbolsFailedMeldung({ onReload, onDismiss }: { onReload: () => void; onDismiss: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.symbols
  useMeldung({
    id: 'symbols',
    kind: 'symbols',
    tone: 'warn',
    icon: 'warn',
    title: C.loadFailedTitle,
    sub: C.loadFailedSub,
    actions: [{ label: C.retry, icon: 'rotate', primary: true, onClick: onReload }],
    dismiss: { label: C.dismiss, onClick: onDismiss },
  })
  return null
}
