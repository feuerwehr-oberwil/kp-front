// A REFUSAL – an act the app declined («Erst «Notfall beendet» halten …») – said where the
// operator can see it (FEEDBACK.1, 17.11.2026).
//
// Everywhere else that is a warn toast. The Atemschutz-Link shows no toasts (30.10.2026, App ·
// `<Overlays toasts={false} />`), so there a refusal was a tap that silently did nothing – on the
// one board handed to the person standing at the door. `refuse()` raises the toast AND notes the
// sentence; the Link mounts `RefusalMeldung` (App), which shows the last one as a Meldeleiste row
// (`meldungen · MELDUNG_RANK.refused`, let through by `linkShowsMeldung`) until its ✕. Where the
// row is not mounted the note is simply never read. Use it for every act that is REFUSED – a
// one-shot «done» confirmation stays a plain toast.

import { useState, useSyncExternalStore } from 'react'
import { appConfig } from '../config/appConfig'
import { toast } from './ui'
import { useMeldung } from './useMeldung'

let last: { text: string; seq: number } | null = null
let seq = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Decline an act out loud: the warn toast, and – on a surface without toasts – the strip's row. */
export function refuse(text: string): void {
  toast(text, { icon: 'warn', tone: 'warn' })
  last = { text, seq: ++seq }
  for (const l of listeners) l()
}

/** The last refusal as a Meldeleiste row, until its ✕ (or the next one replaces it). Mounted where
 *  toasts are off – the Atemschutz-Link. A refusal from before the mount is not this screen's. */
export function RefusalMeldung() {
  const cur = useSyncExternalStore(subscribe, () => last, () => null)
  const [seen, setSeen] = useState(seq)
  const show = cur && cur.seq > seen ? cur : null
  useMeldung(show && {
    id: 'refused',
    kind: 'refused',
    tone: 'warn',
    icon: 'warn',
    title: show.text,
    // the whole sentence is the message («… bleibt in der Überwachung»): wrap, never cut
    wrap: true,
    dismiss: { label: appConfig.copy.closeDialog, onClick: () => setSeen(show.seq) },
  })
  return null
}
