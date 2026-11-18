import { useEffect } from 'react'
import { appConfig } from '../config/appConfig'
import { cancelZielPick } from '../lib/zielPick'
import { Button } from './Button'
import s from './ZielPickBar.module.css'

/**
 * The bar along the foot of the Karte / Plan while the Trupp form's Ziel is being picked there
 * (lib/zielPick, owner pick M5a A, 18.11.2026): what is asked – «Ziel für den Trupp · Symbol
 * antippen» – and «Abbrechen», which brings the form back with its Ziel as it was. Esc does the same.
 *
 * Rendered by the app shell (IncidentWorkspace) for as long as the pick runs on either surface;
 * the shell's `.ziel-pick` class steps the bars and rows it would stand on aside (see the
 * stylesheet), so the bar is the one thing at the bottom and a tap on the surface is a pick.
 */
export function ZielPickBar() {
  const az = appConfig.copy.atemschutz
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelZielPick() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className={s.bar} role="status">
      <span className={s.text}>
        <b>{az.zielPickBarTitle}</b>
        <span>{az.zielPickBarHint}</span>
      </span>
      <Button onClick={cancelZielPick}>{az.cancel}</Button>
    </div>
  )
}
