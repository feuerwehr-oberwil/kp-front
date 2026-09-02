/** «Gespiegelt – zum Original», in the two editors a twin shares with a native object.
 *
 *  A mirrored Linie/Fläche/Form opens the SAME DrawEditor / ShapeEditor its original opens
 *  (that is the point of the mirror), so nothing in those sheets said which document the object
 *  actually lives in — the map twins lost the «Zum Original» jump when they gained full editing,
 *  and the board's twin editor never had one. This is the one line that says it, and the way
 *  there: a quiet action beside Verriegeln, never a banner and never a warning. The plaque
 *  (GeorefTwinPanel) keeps carrying the same fact in its subtitle for the kinds that use it.
 */
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

export function TwinOrigin({ onOriginal }: { onOriginal: () => void }) {
  const label = appConfig.copy.whiteboard.georef.twinOrigin
  return (
    <button className="btn twin-origin" onClick={onOriginal} title={label}>
      <Icon id="external" />{label}
    </button>
  )
}
