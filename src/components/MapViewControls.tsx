import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { MapViewsButton, type ViewsApi } from './MapViewsMenu'
import { RailKey } from './ToolRail'
import { PANEL_KEY } from '../lib/hotkeys'
import { layerPresetLabel, type LayerPreset } from '../lib/layerPreset'

interface Props {
  onZoomIn: () => void
  onZoomOut: () => void
  bearing: number
  views: ViewsApi
  /** no «Ansicht speichern» in the compass menu (a viewer, the el record slice) */
  readOnly: boolean
  viewsOpen: boolean
  onViewsOpenChange: (open: boolean) => void
  coordsOn: boolean
  onToggleCoords: () => void
  /** the Ebenen panel stands open */
  layersOn: boolean
  onToggleLayers: () => void
  /** which quick-tap the layer set matches — named in the button's tooltip / accessible name
   *  (lib/layerPreset, 05.10.2026) */
  layersPreset: LayerPreset
  /** a content layer is off – the amber dot (lib/layerPreset · contentLayerHidden) */
  layersHidden: boolean
}

/**
 * The Karte's VIEW controls – Ebenen · Ansichten · + − – as the tiles of a view bar (07-toolrail ·
 * .view-bar), worded or bare with the rails. ONE set for both places they stand: the editable
 * Lage hands them to its ToolRail (MapToolDocks · `controls`: the bar in the corner, the phone's
 * folded bar), and the Wiedergabe, which has no rail, puts them in the same `ViewBar` in the same
 * bottom-right corner (MapControls; owner, Üben feedback 27.11.2026: «every UI has the core
 * elements at the same place»). Until then the replay had its own cluster top right, in another
 * order and another look.
 */
export function MapViewControls({
  onZoomIn, onZoomOut, bearing, views, readOnly, viewsOpen, onViewsOpenChange, coordsOn, onToggleCoords,
  layersOn, onToggleLayers, layersPreset, layersHidden,
}: Props) {
  const c = appConfig.copy.nav
  return (
    <>
      {/* Ebenen — in the view bar (the phone: the bar's pinned end), so it never scrolls
          out of reach on short iPads; the Basiskarte choice lives inside its panel (the BaseSwitcher popover and
          the standalone Koordinaten button are folded away — coords is a row in
          the compass menu now, testing feedback 2026-07-14) */}
      {/* which preset the Ebenen match is lit in the panel and said in the name — no mark
          on the glyph for it (05.10.2026, owner: «no need for this indicator»). The one
          mark is the amber dot while a CONTENT layer is off (rare-user round 17.11.2026,
          M6 = A): an empty Lage that nothing explains. */}
      <button className={`vrail-nbtn vrail-layers ${layersOn ? 'on' : ''}`} title={`${appConfig.copy.panels.layers} · ${layerPresetLabel(layersPreset)}`} aria-label={`${appConfig.copy.panels.layers} – ${layerPresetLabel(layersPreset)}${layersHidden ? ` · ${appConfig.copy.whiteboard.floorHidden}` : ''}`} aria-expanded={layersOn} onClick={onToggleLayers}><span className="vrail-glyph"><Icon id="layers" />{layersHidden && <span className="layers-off-dot" aria-hidden />}</span><span className="vrail-label">{appConfig.copy.panels.layers}</span><RailKey k={PANEL_KEY.layers} /></button>
      {/* multi-purpose compass: always shown, rotates to the live bearing, and opens the
          saved-views menu (Nach Norden · Einpassen · Standort · Koordinaten · saved
          framings · Ansicht speichern) */}
      <MapViewsButton api={views} bearing={bearing} readOnly={readOnly} variant="rail" btnClassName="vrail-nbtn vrail-views" activeClassName="on" glyphClassName="vrail-compass" label={appConfig.copy.mapViews.title} open={viewsOpen} onOpenChange={onViewsOpenChange} coordsOn={coordsOn} onToggleCoords={onToggleCoords} />
      {/* zoom ±: mouse only (.vrail-zoom is hidden under 1024px and on a coarse
          pointer). Every touch form factor pinches. «+» first, as on every map (owner
          pick C9, 05.11.2026). The pair is its own group, split from the compass by the
          rails' one hairline (owner pick C12) – the view bar draws it before the first
          .vrail-zoom (07-toolrail), so it goes wherever the buttons go. */}
      <button className="vrail-nbtn vrail-zoom" title={c.zoomIn} aria-label={c.zoomIn} onClick={onZoomIn}><span className="vrail-glyph"><Icon id="plus" /></span><span className="vrail-label">{c.zoomIn}</span></button>
      <button className="vrail-nbtn vrail-zoom" title={c.zoomOut} aria-label={c.zoomOut} onClick={onZoomOut}><span className="vrail-glyph"><Icon id="minus" /></span><span className="vrail-label">{c.zoomOut}</span></button>
    </>
  )
}
