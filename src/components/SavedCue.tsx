import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import s from './SavedCue.module.css'

/**
 * «✓ Wird beim Schliessen gespeichert.» — the quiet line an edit sheet carries where its Speichern
 * used to stand (29.09.2026, owner: «everything should be auto-saved without manual confirmations»).
 * The same look as the TimeBlockSheet's «✓ Alles wird laufend gespeichert.» (`copy.savedLive`):
 * a sheet whose edits are live says so, and one that writes when it closes says THAT — so nobody
 * hunts for a button that is not there, and nobody closes it thinking it will throw the edit away
 * (the confirm-with-undo toast after the close is that door).
 */
export function SavedCue({ text = appConfig.copy.savedOnClose, className }: { text?: string; className?: string }) {
  return <p className={cx(s.saved, className)}><Icon id="check" />{text}</p>
}
