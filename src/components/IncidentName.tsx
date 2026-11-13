import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'

// THE Übung marker (round 2b, owner's pick M12 C «Der Name sagt es», 13.11.2026): no tag, no
// colour – a quiet «Übung ·» in the dimmer ink BEFORE the Einsatz name, the same in the head, the
// card, every list, the Karte chip, the poster and the admin list. It is part of the name's line,
// so a name that does not fit ellipsises at its END and the prefix, at the start, never goes.
// Screen readers hear «Übung, Zimmerbrand»: the «·» is drawn only, a hidden comma is read instead.
// Where the name sits inside an aria-label, use `incidentLabel` (lib/format) for the same words.
// The demo welcome's «Demo · Willkommen …» is the one other user (`NamePrefix`).

/** An Einsatz's name with its Übung prefix. `children` is the name – a plain title, or the
 *  phone head's «Stichwort · street» parts (the prefix is then one more flex item of that row). */
export function IncidentName({ exercise, children }: { exercise: boolean; children: ReactNode }) {
  return <>{exercise && <NamePrefix word={appConfig.copy.exercisePrefix} />}{children}</>
}

/** The quiet «Word ·» itself, for a name that is not an Einsatz's. The space after it is a plain
 *  one in the flow (a space at the end of the hidden comma's own box would be dropped from what a
 *  screen reader hears); in the phone head's flex row the row's gap stands in for it. */
export function NamePrefix({ word }: { word: string }) {
  return <><span className="name-prefix">{word}<span className="sr-only">,</span><span aria-hidden> ·</span></span>{' '}</>
}
