import { useControl } from 'react-map-gl/maplibre'
import { AttributionControl as MlAttributionControl } from 'maplibre-gl'

// Attribution stays a closed ⓘ until the operator taps it — on EVERY map surface (Lage,
// admin Objekte, PlanPicker). MapLibre's stock control force-expands: on maps ≤640px (and
// on first becoming compact) `_updateCompact` adds `maplibregl-compact-show`, and on wider
// maps it renders the always-open text bar. This subclass pins compact mode at every width
// and only ever ensures the compact class — the ⓘ toggle (`_toggleAttribution`) still
// opens/closes it on demand. Use with `attributionControl={false}` on the <Map>.
class QuietAttribution extends MlAttributionControl {
  constructor() { super({ compact: true }) }
  override _updateCompact = () => {
    this._container.setAttribute('open', '')
    if (!this._container.classList.contains('maplibregl-compact')) this._container.classList.add('maplibregl-compact')
  }
}

export function QuietAttributionControl() {
  useControl(() => new QuietAttribution(), { position: 'bottom-right' })
  return null
}
