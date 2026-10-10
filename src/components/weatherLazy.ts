import { lazy } from 'react'

/*
 * The weather layer's components, as their own chunk (components/WeatherLayer): the radar
 * source, its pill and the warnings chip are nobody's boot path, so the entry and App chunks do
 * not carry them (scripts/check-bundle-size.mjs). Offline they come out of the precache like
 * every other chunk.
 *
 * ⚠️ A chunk that fails to load (an old tab after a deploy, a flaky line) renders NOTHING instead
 * of throwing into the Karte's error boundary: the weather is an optional layer, and an optional
 * layer must never be what takes the map down at 3am.
 */
type Module = typeof import('./WeatherLayer')
const load = (): Promise<Module | null> => import('./WeatherLayer').catch(() => null)
const nothing = () => null

export const WeatherRadarSource = lazy(() => load().then((m) => ({ default: m?.WeatherRadarSource ?? (nothing as unknown as Module['WeatherRadarSource']) })))
export const WeatherWarningChip = lazy(() => load().then((m) => ({ default: m?.WeatherWarningChip ?? (nothing as unknown as Module['WeatherWarningChip']) })))
export const WeatherRadarControls = lazy(() => load().then((m) => ({ default: m?.WeatherRadarControls ?? (nothing as unknown as Module['WeatherRadarControls']) })))
