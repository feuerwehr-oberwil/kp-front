// The Karte's floating controls on top of the map — the map-utility cluster, the views and
// Ebenen buttons, the replay/locked variants — plus the phone backdrop and the Ebenen dock.
// Split out of IncidentWorkspace (E1, 09.10.2026) verbatim; `mapUI` and `panel` gate them as before.

import { Suspense } from 'react'
import { WeatherFloats } from '../components/weatherLazy'
import type { useRadarPlayback } from '../lib/useRadarPlayback'
import type { useWeatherLayer } from '../lib/useWeatherLayer'
import { WEATHER_RADAR_ROW_ID, type WeatherRadar } from '../lib/weatherLayer'
import type { RefObject, Dispatch, SetStateAction } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { BuildingFloat } from '../components/BuildingFloat'
import { LayerPanel } from '../components/LayerPanel'
import { MapUtility } from '../components/MapUtility'
import type { ViewsApi } from '../components/MapViewsMenu'
import { WeatherBadge } from '../components/TopBar'
import { appConfig } from '../config/appConfig'
import { hasBuildingContent } from '../lib/buildingCard'
import { fmtLV95, fmtWGS } from '../lib/geo'
import type { useGeorefMode } from '../lib/georefMode'
import { type GeorefPlan, planRasterRows } from '../lib/georefTwins'
import { Icon } from '../lib/icons'
import type { useBuildingInfo } from '../lib/useBuildingInfo'
import type { useCoordPicker } from '../lib/useCoordPicker'
import type { useIsPhone } from '../lib/useIsPhone'
import type { LngLat, WeatherData, LayerDef, LayerId } from '../types'
import type { LayerPreset } from '../lib/layerPreset'

export interface MapControlsProps {
  mapUI: boolean
  mapUtility: boolean
  mapRef: RefObject<MapRef | null>
  view: { bearing: number; center: LngLat; zoom: number }
  viewsApi: ViewsApi
  readOnly: boolean
  isEl: boolean
  viewsOpen: boolean
  toggleViews: (open: boolean) => void
  coord: ReturnType<typeof useCoordPicker>
  panel: 'layers' | null
  layersPreset: LayerPreset
  togglePanel: (name: 'layers') => void
  isPhone: ReturnType<typeof useIsPhone>
  slimRail: boolean
  displayWeather: WeatherData | null
  openWeatherDetails: () => void
  replayActive: boolean
  georefMode: ReturnType<typeof useGeorefMode>
  buildingInfo: ReturnType<typeof useBuildingInfo>
  tool: string
  setPanel: Dispatch<SetStateAction<'layers' | null>>
  composerOpen: boolean
  journalOpen: boolean
  offlineReadyOpen: boolean
  layers: LayerDef[]
  toggleLayer: (id: LayerId) => void
  setOpacity: (id: LayerId, v: number) => void
  linkedPlans: GeorefPlan[]
  twinLayers: Record<string, boolean>
  twinLayerOpacity: Record<string, number>
  setAllLayers: (visible: boolean) => void
  resetLayers: () => void
  wxOn: boolean
  wxLayer: ReturnType<typeof useWeatherLayer>
  wxRadarOn: boolean
  wxRadarStale: boolean
  wxPlayback: ReturnType<typeof useRadarPlayback>
  wxRadar: WeatherRadar | null
  wxRadarOpacity: number
}

export function MapControls({
  mapUI, mapUtility, mapRef, view, viewsApi, readOnly, isEl, viewsOpen, toggleViews, coord, panel,
  layersPreset, togglePanel, isPhone, slimRail, displayWeather, openWeatherDetails, replayActive,
  georefMode, buildingInfo, tool, setPanel, composerOpen, journalOpen, offlineReadyOpen, layers,
  toggleLayer, setOpacity, linkedPlans, twinLayers, twinLayerOpacity, setAllLayers, resetLayers,
  wxOn, wxLayer, wxRadarOn, wxRadarStale, wxPlayback, wxRadar, wxRadarOpacity,
}: MapControlsProps) {
  return (
    <>
      {mapUI && (
        <>
          {/* zoom + locate — normally folded into the right ToolRail footer; floats
              top-right only on desktop where the rail is gone (replay, whose scrubber the rail's
              Messen readout would collide with). On a phone the tool bar's footer carries
              Ebenen + the compass, so this cluster isn't rendered there. */}
          {mapUtility && (
            <MapUtility
              onZoomIn={() => mapRef.current?.zoomIn()}
              onZoomOut={() => mapRef.current?.zoomOut()}
              bearing={view.bearing}
              views={viewsApi}
              // `|| isEl`: saved camera views live in the shared blob (cameraViews), which the
              // el record slice never pushes — offering «Speichern» would fake a shared save
              readOnly={readOnly || isEl}
              viewsOpen={viewsOpen}
              onViewsOpenChange={toggleViews}
              coordsOn={coord.mode !== 'off'}
              onToggleCoords={coord.cycle}
              layersOn={panel === 'layers'}
              layersPreset={layersPreset}
              onToggleLayers={() => togglePanel('layers')}
            />
          )}

          {/* phone: the wind read-out floats top-right under the bar — the top bar clipped it at
              the screen edge (that bar already carries switcher · Einsatzuhr · undo/redo ·
              Verlauf). NOT on a read-only surface: there the top bar has room for the weather
              (measured: 96px free with no undo/redo/Eintrag). The compass is NOT up here: it sits
              in the tool bar, beside Ebenen, where the map's other controls are (05.08.2026). It
              floated here again for one day (18.09.) and came back down — above the bar its menu
              opened half a screen away from the thumb that asked for it. */}
          {/* the weather layer's floating pieces (lazy): the warnings chip — whether the radar is
              on or not — and, while «Niederschlag» is on, the radar's pill. Not in the replay. */}
          {wxOn && wxLayer.data && !replayActive && (
            <Suspense fallback={null}>
              <WeatherFloats layer={wxLayer.data} now={wxLayer.now} isPhone={isPhone}
                radarOn={wxRadarOn} radarStale={wxRadarStale} frameIndex={wxPlayback.frameIndex}
                playing={wxPlayback.playing} onPick={wxPlayback.pick} onTogglePlaying={wxPlayback.togglePlaying} />
            </Suspense>
          )}

          {isPhone && !slimRail && displayWeather?.wind_dir_deg != null && (
            <div className="phone-wx">
              <WeatherBadge weather={displayWeather} onOpenMeteo={openWeatherDetails} bearing={view.bearing} popAlignOffset={-5} />
            </div>
          )}

          {/* coordinate readout — bottom-centre; aiming follows the cursor, set is locked.
              hidden during replay so it never stacks under the bottom-centre scrubber. The ✕ on
              its right is the same exit in both states — the mode used to be leavable only from
              the compass menu, two taps away, while it swallowed every map tap (02.09.). */}
          {/* The Gebäude chip — the Karte's bottom-left chip row, the same place and recipe as the
              plan's (Whiteboard · .wb-botleft), so Lage and Plan say it in one spot. Rendered only
              with something to say: the row's presence alone lifts the message lane. Not during
              replay (a past Lage, and its scrubber owns the foot) or «Karte verknüpfen». */}
          {!replayActive && !georefMode.planId && hasBuildingContent(buildingInfo) && (
            <div className="wb-botleft"><BuildingFloat info={buildingInfo} compact={isPhone} /></div>
          )}

          {coord.readout && !replayActive && (
            <div className={`coord-read${coord.mode === 'aim' ? ' aiming' : ''}${tool === 'measure' ? ' coord-read-stacked' : ''}`} role="status">
              <div className="cr-rows">
                <div className="cr-row"><span className="cr-tag">LV95</span><span className="cr-val">{fmtLV95(coord.readout[0], coord.readout[1])}</span></div>
                <div className="cr-row"><span className="cr-tag">WGS84</span><span className="cr-val">{fmtWGS(coord.readout[0], coord.readout[1])}</span></div>
              </div>
              <button type="button" className="cr-x" aria-label={appConfig.copy.nav.coordsExit} onClick={() => coord.setMode('off')}>
                <Icon id="close" />
              </button>
              <div className="cr-hint">{coord.mode === 'aim' ? appConfig.copy.nav.coordsHint : appConfig.copy.nav.coordsLocked}</div>
            </div>
          )}

        </>
      )}

      {/* click-away: a transparent full-screen backdrop closes the open map panel */}
      {/* phone only: a tap-catcher behind the panel sheet to close it. On desktop the panel
          floats as a side card, so NO backdrop — the map stays pannable with Ebenen open. */}
      {/* ⚠️ The KARTE's backdrop, and only it (15.09.2026). The Plan half used to be here for a
          LayerPanel the Plan no longer has — and with the panel gone the catcher was the whole
          bug it was once written to avoid: a full-screen z28 sheet over the z20 whiteboard,
          eating the first tap on a board that looked perfectly normal. */}
      {mapUI && panel !== null && isPhone && <div className="mapctl-backdrop" onClick={() => setPanel(null)} />}

      {/* the Ebenen dock (.layers-card z201) sits ABOVE the +Eintrag composer / Verlauf
          scrim that covers every other map popup, so it needs an explicit guard to hide
          with them — otherwise it pokes through the modal (parity with the tool popups) */}
      {mapUI && panel === 'layers' && !composerOpen && !journalOpen && !offlineReadyOpen && (
        <LayerPanel
          layers={layers}
          onToggle={toggleLayer}
          onOpacity={setOpacity}
          twins={planRasterRows(linkedPlans, twinLayers, twinLayerOpacity)}
          // …directly under «Lage», wherever the deployment's config calls that group: the sheet
          // a symbol was drawn on belongs beside that symbol, not past Wasser and Gefahren.
          twinsAfterGroup={layers.find((l) => l.id === appConfig.defaults.operationalLayerId)?.group}
          weather={wxOn ? {
            id: WEATHER_RADAR_ROW_ID,
            group: appConfig.copy.weatherLayer.group,
            label: appConfig.copy.weatherLayer.radar,
            sub: appConfig.copy.weatherLayer.radarSub,
            icon: 'wx-rain',
            visible: wxRadarOn,
            opacity: wxRadarOpacity,
            attribution: appConfig.copy.weatherLayer.attribution,
            legend: wxRadar?.legend ?? [],
          } : undefined}
          onShowAll={() => setAllLayers(true)}
          onHideAll={() => setAllLayers(false)}
          onReset={resetLayers}
          preset={layersPreset}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  )
}
