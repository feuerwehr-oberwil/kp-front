// SPIKE «Üben» (19.11.2026): the pill over the practice Einsatz — it says that the work stays on
// this device, and its confirm holds the two ways out: «Neu beginnen» (wipe: lib/practice/
// practiceMode · resetPractice, then a reload) and «Übung beenden» (mode off, home). Rendered by
// App while the practice Einsatz is on screen. The words are inline for the spike; the real build
// puts them in appConfig.copy and the pill into the Meldeleiste.

import { confirmDialog } from '../ui'
import { loadPrefs, savePrefs } from '../prefs'
import { resetPractice, setPracticeMode } from './practiceMode'

export function PracticeBar() {
  const open = async () => {
    const answer = await confirmDialog({
      title: 'Übung auf diesem Gerät',
      message: 'Diese Übung bleibt auf diesem Gerät: kein anderes Gerät und kein Einsatzverzeichnis sieht sie. «Neu beginnen» löscht Karte, Verlauf, Trupps und Rapport der Übung.',
      confirmLabel: 'Neu beginnen',
      altLabel: 'Übung beenden',
      cancelLabel: 'Weiter üben',
      danger: true,
    })
    if (answer === true) {
      resetPractice()
      window.location.reload()
    } else if (answer === 'alt') {
      setPracticeMode(false)
      savePrefs({ ...loadPrefs(), incidentId: undefined })
      window.location.assign('/')
    }
  }
  return (
    <button
      type="button"
      data-practice-bar
      onClick={() => void open()}
      style={{
        position: 'fixed', left: 'var(--sp-4)', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 148px)',
        zIndex: 'var(--z-messages)', minHeight: 44, padding: '0 var(--sp-4)', borderRadius: 'var(--r-pill)',
        background: 'var(--amber-22)', color: 'var(--ink)', border: '1px solid var(--amber-45)',
        fontSize: 'var(--fs-2)', fontWeight: 'var(--fw-medium)', whiteSpace: 'nowrap',
      }}
    >
      Übung · nur hier
    </button>
  )
}
