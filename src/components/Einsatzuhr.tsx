import type { ReactElement } from 'react'
import { Popover, PopoverClose } from '../lib/overlays'
import { fillTemplate, formatTime } from '../lib/format'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { CLOCK_ICON, CLOCK_MODES, type Einsatzuhr } from '../lib/einsatzuhr'

/** The mode menu, opened by whatever `trigger` the reader draws (the bar's clock button, or the
 *  Einsatz card's Beginn pill on a phone). */
export function EinsatzuhrMenu({ uhr, startedAt, trigger, align = 'start' }: {
  uhr: Einsatzuhr
  startedAt: string
  trigger: ReactElement
  align?: 'start' | 'center' | 'end'
}) {
  const E = appConfig.copy.einsatzuhr
  return (
    <Popover
      side="bottom"
      align={align}
      popupClassName="tb-uhr-menu"
      ariaLabel={fillTemplate(E.title, { t: formatTime(new Date(startedAt)) })}
      trigger={trigger}
    >
      {CLOCK_MODES.map((m) => (
        <PopoverClose key={m} className={`tb-uhr-row${uhr.mode === m ? ' on' : ''}`} onClick={() => uhr.pick(m)}>
          <Icon id={CLOCK_ICON[m]} /><span className="tb-uhr-lbl">{uhr.label[m]}</span>
          <span className="tb-uhr-val">{uhr.value(m)}</span><Icon id="check" className="tb-uhr-chk" />
        </PopoverClose>
      ))}
    </Popover>
  )
}

/** The same three modes as an INLINE choice, for the phone's Einsatz card (owner, 07.10.2026: no
 *  popover over the Einsatz menu, which already is one). Rows a --tap tall with their values and
 *  a tick on the current mode, the menu's own rows (`.tb-uhr-row`); a pick closes the list. */
export function EinsatzuhrChoices({ uhr, ariaLabel, onPicked }: {
  uhr: Einsatzuhr
  ariaLabel: string
  onPicked: () => void
}) {
  return (
    <div className="ip-uhr-list" role="radiogroup" aria-label={ariaLabel}>
      {CLOCK_MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={uhr.mode === m}
          className={`tb-uhr-row${uhr.mode === m ? ' on' : ''}`} onClick={() => { uhr.pick(m); onPicked() }}>
          <Icon id={CLOCK_ICON[m]} /><span className="tb-uhr-lbl">{uhr.label[m]}</span>
          <span className="tb-uhr-val">{uhr.value(m)}</span><Icon id="check" className="tb-uhr-chk" />
        </button>
      ))}
    </div>
  )
}
